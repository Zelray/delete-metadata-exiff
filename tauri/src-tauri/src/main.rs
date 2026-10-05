#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! MetaDesk desktop shell (leaf 2.1.1).
//!
//! The shell owns ONE thing: the lifecycle of the bundled engine (node.exe +
//! server bundle + its exiftool.exe child), per the pinned ladder in
//! `.unlazy/metagui-phase2/BUILD-NOTES.md`:
//!
//!   0. launch sweep (stale/orphan engine residue, image-path checked)
//!   1. spawn the bundled engine as a direct child, Job Object backstop
//!   2. health gate, then the hidden window navigates to the engine's URL
//!   3. on close: drop stdin, grace poll, escalate to a tree kill, sweep (steps 3-5)
//!   4. the Job Object backstops any death that skips the graceful ladder
//!
//! The engine being UNHEALTHY is not a boot failure (the server boots degraded
//! read-only by design); only a spawn failure, a pre-listen exit, or a health
//! deadline is a dialog + non-zero exit. No tray, no drag-drop wiring here —
//! both belong to leaf 2.1.2.

mod dialog;
mod engine;
mod logging;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{App, AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_single_instance::init as single_instance_init;

use engine::EngineState;

const WINDOW_LABEL: &str = "main";
const WINDOW_TITLE: &str = "MetaDesk";
const WINDOW_WIDTH: f64 = 1360.0;
const WINDOW_HEIGHT: f64 = 900.0;
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// A beat for the closing webview to drop the UI's SSE connection before the
/// engine's stop channel is pulled (the engine cannot finish its own close
/// while a request is in flight). Measured: with the stream already dropped the
/// engine exits in ~3 s; without dropping it, it never exits on its own.
const SOCKET_SETTLE: Duration = Duration::from_millis(750);
/// How long the event loop waits for a close ladder that a worker thread is
/// already running before falling back to running it inline.
const LADDER_JOIN_WINDOW: Duration = Duration::from_secs(20);

fn main() {
    // WebView2 must exist before anything else: a missing runtime has to
    // produce a branded dialog with the download link, never a white window.
    if let Err(error) = tauri::webview_version() {
        logging::line(
            "boot",
            &format!("WebView2 runtime not found: {error}"),
        );
        dialog::fatal(
            &format!(
                "MetaDesk needs the Microsoft Edge WebView2 runtime, which is not installed on this PC.\n\n\
                 Install it from:\n{}\n\nthen start MetaDesk again.\n\n(details: {error})",
                dialog::WEBVIEW2_DOWNLOAD
            ),
            2,
        );
    }

    tauri::Builder::default()
        // PINNED (D5): single-instance is the FIRST plugin registered. A second
        // launch forwards its args here and exits before it can touch anything.
        .plugin(single_instance_init(|app, _args, _cwd| {
            logging::line("single", "second launch: focusing the existing window");
            focus_existing(app);
        }))
        .setup(|app| boot(app))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                if window.label() == WINDOW_LABEL {
                    // Window close = QUIT (no prevent_close / prevent_exit
                    // anywhere in v1). The window goes away NOW (the user's
                    // close must feel instant) and the ladder runs on a worker
                    // thread so it cannot freeze the closing window.
                    let _ = window.hide();
                    // Drop the page's SSE connection before the webview dies:
                    // the engine cannot finish its own close while a request is
                    // still in flight, and WebView2's browser process keeps the
                    // socket open after the window is gone. Navigating the
                    // webview away discards the document and aborts the stream.
                    if let Some(webview_window) = window.app_handle().get_webview_window(WINDOW_LABEL) {
                        if let Ok(blank) = tauri::Url::parse("about:blank") {
                            let _ = webview_window.navigate(blank);
                        }
                    }
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || {
                        // A beat for that socket close to reach the engine.
                        std::thread::sleep(SOCKET_SETTLE);
                        let state = app.state::<EngineState>();
                        engine::shutdown(&state, "window closed");
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("MetaDesk shell failed to build")
        .run(|app, event| {
            // Backstop for exits that never saw a CloseRequested (app.exit from
            // the crash watcher, OS shutdown, a second launch exiting inside
            // plugin setup, ...): run the ladder before the process goes away,
            // waiting out one that a close click already started on a worker
            // thread. Idempotent. `try_state` because a second launch exits
            // before this process ever ran `boot` and has no state to shut down.
            if let RunEvent::Exit = event {
                let Some(state) = app.try_state::<EngineState>() else {
                    return;
                };
                let started = std::time::Instant::now();
                while !state.ladder_done.load(Ordering::SeqCst) && started.elapsed() < LADDER_JOIN_WINDOW {
                    std::thread::sleep(Duration::from_millis(50));
                }
                engine::shutdown(&state, "app exit");
            }
        });
}

/// The boot ladder: paths, sweep, spawn, health gate, window. Any failure that
/// is a real boot failure ends in a branded dialog and a non-zero exit, with
/// everything this boot spawned already torn down.
fn boot(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let package_root = match std::env::current_exe().ok().and_then(|path| path.parent().map(PathBuf::from)) {
        Some(root) => root,
        None => {
            dialog::fatal("MetaDesk cannot find its own folder. Reinstall the app.", 1);
        }
    };

    // The data dir: the launcher's env var wins (the verify gate injects a temp
    // dir); the portable shape keeps it in-folder.
    let data_dir = std::env::var_os("METADESK_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| package_root.join("data"));

    let node_exe = package_root.join("node").join("node.exe");
    let bundle_path = package_root.join("server").join("dist").join("server.mjs");

    let missing = [&node_exe, &bundle_path]
        .into_iter()
        .filter(|path| !path.exists())
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    if !missing.is_empty() {
        dialog::fatal(
            &format!(
                "MetaDesk's installation looks incomplete.\n\nMissing: {missing}\n\nReinstall the app (extract the whole folder, not just the .exe)."
            ),
            1,
        );
    }

    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        dialog::fatal(
            &format!(
                "MetaDesk cannot create its data folder:\n{}\n\n({error})\n\nCheck that the app folder is writable.",
                data_dir.display()
            ),
            1,
        );
    }

    logging::init(&data_dir);
    logging::line("boot", &format!("MetaDesk shell {APP_VERSION} starting"));
    logging::line(
        "boot",
        &format!(
            "package root {}, data dir {}",
            package_root.display(),
            data_dir.display()
        ),
    );

    let state = EngineState::new(data_dir, node_exe, bundle_path);
    app.manage(state);

    // ---- step 0: launch sweep ---------------------------------------------------
    let state = app.state::<EngineState>();
    match engine::launch_sweep(&state) {
        engine::SweepOutcome::Clear => logging::line("sweep", "nothing stale to sweep"),
        engine::SweepOutcome::Swept(detail) => logging::line("sweep", &format!("swept: {detail}")),
        engine::SweepOutcome::OwnedByLauncher { launcher_pid } => {
            // A dev launcher (bin\metadesk.mjs) owns the engine. Never start a
            // second one, never kill it — say so and leave quietly.
            logging::line(
                "boot",
                &format!("a dev launcher (pid {launcher_pid}) already owns the engine; not starting"),
            );
            dialog::warning(&format!(
                "MetaDesk is already running from a development launcher (process {launcher_pid}).\n\n\
                 Close that console window first, then start MetaDesk again."
            ));
            std::process::exit(0);
        }
    }

    // ---- step 1: spawn ----------------------------------------------------------
    let pid = match engine::spawn_engine(&state) {
        Ok(pid) => pid,
        Err(message) => {
            logging::line("boot", &format!("spawn failed: {message}"));
            dialog::fatal(
                &format!(
                    "MetaDesk could not start its engine.\n\n{message}\n\nDetails: {}",
                    logging::path().display()
                ),
                1,
            );
        }
    };

    // ---- step 2: health gate ----------------------------------------------------
    let answer = match engine::wait_for_health(&state) {
        Ok(answer) => answer,
        Err(message) => {
            logging::line("boot", &format!("health gate failed: {message}"));
            engine::shutdown(&state, "boot failure");
            dialog::fatal(
                &format!(
                    "MetaDesk's engine did not start in time.\n\n{message}\n\nDetails: {}",
                    logging::path().display()
                ),
                1,
            );
        }
    };
    if !answer.portfile.engine.is_empty() {
        logging::line("boot", &format!("engine executable: {}", answer.portfile.engine));
    }
    if answer.engine_ok {
        logging::line(
            "boot",
            &format!("engine healthy ({}), pid {pid}", answer.engine_version),
        );
    } else {
        // NOT a boot failure: the server boots degraded read-only on purpose.
        logging::line(
            "WARN",
            &format!(
                "engine degraded ({}): {} - MetaDesk starts READ-ONLY",
                answer.engine_version, answer.reason
            ),
        );
    }

    // ---- the window -------------------------------------------------------------
    let Ok(url) = answer.portfile.url().parse::<tauri::Url>() else {
        engine::shutdown(&state, "boot failure");
        dialog::fatal(
            &format!(
                "MetaDesk's engine reported an unusable address.\n\n{}\n\nDetails: {}",
                answer.portfile.url(),
                logging::path().display()
            ),
            1,
        );
    };

    // Hidden until it holds the engine's page, then shown — never a white or
    // half-loaded window in front of the user.
    let window = match WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title(WINDOW_TITLE)
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(960.0, 640.0)
        .visible(false)
        .build()
    {
        Ok(window) => window,
        Err(error) => {
            engine::shutdown(&state, "boot failure");
            dialog::fatal(
                &format!(
                    "MetaDesk could not open its window.\n\n{error}\n\nDetails: {}",
                    logging::path().display()
                ),
                1,
            );
        }
    };

    if window.show().is_err() || window.set_focus().is_err() {
        logging::line("WARN", "the window could not be shown or focused");
    }
    logging::line(
        "boot",
        &format!("window shown at {}", answer.portfile.url()),
    );

    watch_engine(app.handle().clone(), pid);
    Ok(())
}

/// Ladder step 7: if the engine dies while the window is open, say so and quit.
/// NO silent auto-restart — a process that died mid-write is exactly what the
/// journal/backup/recovery pipeline exists for.
fn watch_engine(app: AppHandle, pid: u32) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let state = app.state::<EngineState>();
        if state.stopping.load(Ordering::SeqCst) {
            return;
        }
        match engine::child_running(&state) {
            Some(None) => {} // still running
            Some(Some(code)) => {
                logging::line(
                    "WARN",
                    &format!("engine pid {pid} exited unexpectedly (code {code})"),
                );
                engine::shutdown(&state, "engine exited unexpectedly");
                dialog::warning(&format!(
                    "MetaDesk's engine stopped unexpectedly (exit code {code}).\n\n\
                     Your data is safe: every write is journalled and backed up before it lands.\n\n\
                     Details: {}",
                    logging::path().display()
                ));
                app.exit(1);
                return;
            }
            None => return, // never spawned / already taken
        }
    });
}

fn focus_existing(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
