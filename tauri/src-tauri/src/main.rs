#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! MetaDesk desktop shell (leaves 2.1.1 + 2.1.2).
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
//!   7. crash while the window is open: a native Reopen / Quit dialog — never
//!      a silent auto-restart (Reopen re-runs steps 0-2 on the same window)
//!
//! Around that ladder, leaf 2.1.2 adds exactly two chrome pieces:
//!   * the D6 minimal tray (left-click focus; right-click Open + Quit — Quit
//!     rides the SAME teardown as the window close button; no close-to-tray,
//!     no `prevent_close` / `prevent_exit` anywhere), and
//!   * the drag-drop lane: Tauri's own drop handler stays ON (default), so
//!     Explorer drops arrive here as ABSOLUTE paths and are emitted to the
//!     page (`metadesk://dropped-paths`, a JSON array of path strings) for the
//!     UI's tauri bridge to consume.
//!
//! The engine being UNHEALTHY is not a boot failure (the server boots degraded
//! read-only by design); only a spawn failure, a pre-listen exit, or a health
//! deadline is a dialog + non-zero exit.

mod dialog;
mod engine;
mod logging;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    App, AppHandle, DragDropEvent, Emitter, Manager, RunEvent, WebviewEvent, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
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

/// The drag-drop channel to the page (SPIKE-1 proved a remote-origin page at
/// the dynamic port can listen, via `core:event:default` + the port-wildcard
/// capability). Payload: a JSON array of absolute path strings.
const DROPPED_PATHS_EVENT: &str = "metadesk://dropped-paths";
const TRAY_ICON_ID: &str = "metadesk-tray";
const TRAY_OPEN_ID: &str = "metadesk-open";
const TRAY_QUIT_ID: &str = "metadesk-quit";

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
                    // anywhere in v1). The one quit path below tears the
                    // engine down; the tray's Quit lands here too.
                    begin_quit(window.app_handle(), "window closed");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("MetaDesk shell failed to build")
        .run(|app, event| match event {
            // Tauri's drag-drop handler is ON (default), which REPLACES the
            // WebView2 HTML5 drop path: Explorer drops arrive HERE, already
            // carrying absolute paths. Forward them to the page; the UI's
            // tauriBridge listens and fills the Home folder box. (The browser
            // dev seam keeps its HTML5 handler — it never sees these events.)
            RunEvent::WebviewEvent { label, event, .. } => {
                if label == WINDOW_LABEL {
                    if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                        forward_dropped_paths(app, paths);
                    }
                }
            }
            // Backstop for exits that never saw a CloseRequested (tray Quit,
            // app.exit from the crash watcher, OS shutdown, a second launch
            // exiting inside plugin setup, ...): run the ladder before the
            // process goes away, waiting out one that a close click already
            // started on a worker thread. Idempotent. `try_state` because a
            // second launch exits before this process ever ran `boot` and has
            // no state to shut down.
            RunEvent::Exit => {
                let Some(state) = app.try_state::<EngineState>() else {
                    return;
                };
                let started = std::time::Instant::now();
                while !state.ladder_done.load(Ordering::SeqCst) && started.elapsed() < LADDER_JOIN_WINDOW {
                    std::thread::sleep(Duration::from_millis(50));
                }
                engine::shutdown(&state, "app exit");
            }
            _ => {}
        });
}

// ---------------------------------------------------------------------------
// Boot — and the crash dialog's Reopen, which re-runs the same ladder
// ---------------------------------------------------------------------------

/// The full branded dialog text for a real boot failure. `start_engine` has
/// already torn down anything the attempt spawned before returning this.
struct BootFailure(String);

/// What a completed steps-0-2 run looks like.
struct EngineUp {
    pid: u32,
    answer: engine::HealthAnswer,
}

impl EngineUp {
    fn url(&self) -> String {
        self.answer.portfile.url()
    }
}

enum StartError {
    /// A live dev launcher owns the engine (never start a second one).
    DevLauncher(u32),
    /// A real failure: `BootFailure` carries the exact branded dialog text and
    /// everything this attempt spawned is already torn down.
    Failed(BootFailure),
}

/// Ladder steps 0-2: launch sweep, spawn, health gate. Shared by the boot path
/// and by the crash dialog's Reopen, so a restart rides the IDENTICAL code —
/// there is no second lifecycle implementation to drift out of sync.
fn start_engine(state: &EngineState) -> Result<EngineUp, StartError> {
    // ---- step 0: launch sweep ---------------------------------------------------
    match engine::launch_sweep(state) {
        engine::SweepOutcome::Clear => logging::line("sweep", "nothing stale to sweep"),
        engine::SweepOutcome::Swept(detail) => logging::line("sweep", &format!("swept: {detail}")),
        engine::SweepOutcome::OwnedByLauncher { launcher_pid } => {
            // A dev launcher (bin\metadesk.mjs) owns the engine. Never start a
            // second one, never kill it — say so and leave.
            return Err(StartError::DevLauncher(launcher_pid));
        }
    }

    // ---- step 1: spawn ----------------------------------------------------------
    let pid = match engine::spawn_engine(state) {
        Ok(pid) => pid,
        Err(message) => {
            logging::line("boot", &format!("spawn failed: {message}"));
            return Err(StartError::Failed(BootFailure(format!(
                "MetaDesk could not start its engine.\n\n{message}\n\nDetails: {}",
                logging::path().display()
            ))));
        }
    };

    // ---- step 2: health gate ----------------------------------------------------
    let answer = match engine::wait_for_health(state) {
        Ok(answer) => answer,
        Err(message) => {
            logging::line("boot", &format!("health gate failed: {message}"));
            engine::shutdown(state, "boot failure");
            return Err(StartError::Failed(BootFailure(format!(
                "MetaDesk's engine did not start in time.\n\n{message}\n\nDetails: {}",
                logging::path().display()
            ))));
        }
    };

    if !answer.portfile.engine.is_empty() {
        logging::line(
            "boot",
            &format!("engine executable: {}", answer.portfile.engine),
        );
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

    Ok(EngineUp { pid, answer })
}

/// The boot ladder: paths, sweep, spawn, health gate, window, tray, watcher.
/// Any failure that is a real boot failure ends in a branded dialog and a
/// non-zero exit, with everything this boot spawned already torn down.
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

    // ---- steps 0-2: sweep, spawn, health gate (shared with Reopen) --------------
    let state = app.state::<EngineState>();
    let up = match start_engine(&state) {
        Ok(up) => up,
        Err(StartError::DevLauncher(launcher_pid)) => {
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
        Err(StartError::Failed(BootFailure(text))) => {
            dialog::fatal(&text, 1);
        }
    };

    // ---- the window -------------------------------------------------------------
    let Ok(url) = up.url().parse::<tauri::Url>() else {
        engine::shutdown(&state, "boot failure");
        dialog::fatal(
            &format!(
                "MetaDesk's engine reported an unusable address.\n\n{}\n\nDetails: {}",
                up.url(),
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
        &format!("window shown at {}", up.url()),
    );

    // ---- the chrome: D6 minimal tray --------------------------------------------
    if let Err(error) = setup_tray(app.handle()) {
        logging::line(
            "WARN",
            &format!("the tray icon could not be set up ({error}); the window still works normally"),
        );
    }

    watch_engine(app.handle().clone(), up.pid);
    Ok(())
}

/// Ladder step 7's Reopen: the SAME steps-0-2 ladder as boot, then the still-
/// open window is pointed at the fresh engine's URL. Runs on the crash-watcher
/// thread (the health gate blocks; the event loop — tray, menus, window — must
/// stay responsive while it runs). Called only from the dialog: there is NO
/// silent auto-restart anywhere in this crate.
fn restart_engine(app: &AppHandle) -> Result<u32, String> {
    let state = app.state::<EngineState>();
    let up = match start_engine(&state) {
        Ok(up) => up,
        Err(StartError::DevLauncher(launcher_pid)) => {
            return Err(format!(
                "MetaDesk could not reopen.\n\nA development launcher (process {launcher_pid}) owns the engine now. Close that console window, then quit MetaDesk and start it again.\n\nDetails: {}",
                logging::path().display()
            ));
        }
        Err(StartError::Failed(BootFailure(text))) => return Err(text),
    };

    let Ok(url) = up.url().parse::<tauri::Url>() else {
        engine::shutdown(&state, "reopen produced an unusable address");
        return Err(format!(
            "MetaDesk's engine reported an unusable address.\n\n{}\n\nDetails: {}",
            up.url(),
            logging::path().display()
        ));
    };

    // The window is open (the crash happened while it was up) but is showing a
    // dead page. Re-point it on the main thread — the same trip a first boot
    // takes, minus the rebuild.
    let handle = app.clone();
    let repoint = move || {
        if let Some(window) = handle.get_webview_window(WINDOW_LABEL) {
            let _ = window.navigate(url);
            let _ = window.show();
            let _ = window.set_focus();
        }
    };
    if let Err(error) = app.run_on_main_thread(repoint) {
        engine::shutdown(&state, "reopen could not reach the window");
        return Err(format!(
            "MetaDesk reopened its engine but could not reload the window.\n\n{error}\n\nDetails: {}",
            logging::path().display()
        ));
    }

    logging::line("boot", &format!("engine reopened (pid {})", up.pid));
    Ok(up.pid)
}

/// Ladder step 7: if the engine dies while the window is open, ASK — Reopen
/// (re-runs the boot ladder on the same window) or Quit (runs the shutdown
/// ladder and exits). NO silent auto-restart: a process that died mid-write is
/// exactly what the journal/backup/recovery pipeline exists for.
fn watch_engine(app: AppHandle, mut pid: u32) {
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
                match dialog::engine_stopped(code, &logging::path().display().to_string()) {
                    dialog::CrashChoice::Reopen => match restart_engine(&app) {
                        Ok(new_pid) => {
                            pid = new_pid;
                        }
                        Err(message) => {
                            logging::line("ERROR", &format!("reopen failed: {message}"));
                            dialog::error(&message);
                            engine::shutdown(&state, "engine stopped and could not be reopened");
                            app.exit(1);
                            return;
                        }
                    },
                    dialog::CrashChoice::Quit => {
                        engine::shutdown(&state, "engine stopped (user chose Quit)");
                        app.exit(1);
                        return;
                    }
                }
            }
            None => return, // never spawned / already taken
        }
    });
}

// ---------------------------------------------------------------------------
// The one quit path (ladder steps 3-5) and the drag-drop lane
// ---------------------------------------------------------------------------

/// The ONE quit path. The window close button AND the tray's Quit both land
/// here: the window goes away now (a close must feel instant), the page's SSE
/// connection dies with the about:blank trip (the engine cannot finish its own
/// close while a request is in flight, and WebView2's browser process keeps the
/// socket open after the window is gone), then the ladder runs on a worker
/// thread so it cannot freeze whatever the user is still looking at.
fn begin_quit(app: &AppHandle, reason: &'static str) {
    if let Some(webview_window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = webview_window.hide();
        if let Ok(blank) = tauri::Url::parse("about:blank") {
            let _ = webview_window.navigate(blank);
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // A beat for that socket close to reach the engine.
        std::thread::sleep(SOCKET_SETTLE);
        let state = app.state::<EngineState>();
        engine::shutdown(&state, reason);
    });
}

/// Explorer dropped files on the window: hand the page the real absolute paths.
/// The UI scans ONE folder, so when a drop mixes folders and files the first
/// FOLDER moves to the front (stable: order inside each group is preserved)
/// and the payload stays a plain JSON array of absolute path strings.
fn forward_dropped_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let mut ordered = paths;
    ordered.sort_by_key(|path| !path.is_dir());
    let dropped: Vec<String> = ordered
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    logging::line(
        "drop",
        &format!("dropped {} path(s); first: {}", dropped.len(), dropped[0]),
    );
    if let Err(error) = app.emit(DROPPED_PATHS_EVENT, dropped) {
        logging::line(
            "WARN",
            &format!("could not forward the drop to the page: {error}"),
        );
    }
}

// ---------------------------------------------------------------------------
// D6 — the minimal chrome-only tray
// ---------------------------------------------------------------------------

/// Left-click = focus (unminimize + show + set_focus — the same trip a second
/// launch takes). Right-click menu = Open + Quit; Quit rides the exact ladder
/// via `begin_quit`. No close-to-tray, no `prevent_close` / `prevent_exit`.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open MetaDesk", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit MetaDesk", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .menu(&menu)
        // The menu is right-click only; a plain left click focuses.
        .show_menu_on_left_click(false)
        .tooltip("MetaDesk")
        .on_menu_event(|app, event| {
            if event.id() == TRAY_QUIT_ID {
                logging::line("tray", "quit requested from the tray");
                begin_quit(app, "quit from the tray");
                app.exit(0);
            } else if event.id() == TRAY_OPEN_ID {
                focus_existing(app);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_existing(tray.app_handle());
            }
        });

    // The tray carries the same icon as the exe and the taskbar: tauri-build
    // embeds bundle.icon (icons/icon.ico) as the app icon resource.
    match app.default_window_icon().cloned() {
        Some(icon) => builder = builder.icon(icon),
        None => logging::line("WARN", "no app icon resource for the tray icon"),
    }

    builder.build(app)?;
    logging::line("tray", "tray icon ready (left-click focus, right-click Open + Quit)");
    Ok(())
}

fn focus_existing(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
