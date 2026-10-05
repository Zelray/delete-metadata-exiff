//! The bundled engine's lifecycle — the pinned ladder from
//! `.unlazy/metagui-phase2/BUILD-NOTES.md` ("The lifecycle ladder"), steps 0-5.
//!
//! Invariants this module must never break:
//!   * argv-array execution only (`std::process::Command` with an explicit
//!     program and args, never a shell string) — house rule, binds Rust too;
//!   * the launch sweep checks the IMAGE PATH before killing anything, so a
//!     portfile that names a process we did not create is left alone;
//!   * the child is assigned to a Job Object with
//!     `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the node.exe + exiftool.exe
//!     tree dies with the shell even if the shell dies violently;
//!   * the child's stdin pipe is THE stop channel (Windows sends no signals),
//!     held in Tauri managed state for the shell's whole life;
//!   * we never kill an exiftool process we did not create.

use serde::Deserialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::logging;

/// `CREATE_NO_WINDOW`: the engine must never flash a console of its own.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Step 2's health deadline (pinned: ~20 s).
pub const HEALTH_DEADLINE: Duration = Duration::from_secs(20);
/// Step 4's grace window (pinned: ~5 s).
pub const GRACE_WINDOW: Duration = Duration::from_secs(5);
/// Step 5's escalation window (pinned: ~5 s).
pub const ESCALATION_WINDOW: Duration = Duration::from_secs(5);

pub const PORTFILE_NAME: &str = "portfile.json";
pub const LOCK_NAME: &str = "instance.lock";

/// The launcher handshake file the SERVER writes (never us):
/// `{port, token, pid, startedAt, engine, url}`. The pid of record for the
/// whole lifecycle. The per-launch `token` and `startedAt` are not the shell's
/// business — the server injects the token into the page itself — so serde's
/// default "ignore unknown fields" behaviour keeps them out of this struct.
#[derive(Debug, Clone, Deserialize)]
pub struct Portfile {
    pub port: u16,
    pub pid: u32,
    /// Absolute path of the exiftool.exe the server actually loaded: the proof
    /// that the packaged engine folder is the one in use.
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub url: String,
}

impl Portfile {
    pub fn url(&self) -> String {
        if self.url.is_empty() {
            format!("http://127.0.0.1:{}/", self.port)
        } else {
            self.url.clone()
        }
    }
}

/// `{launcherPid, serverPid, port, startedAt, dataDir}` — written by the dev
/// launcher (`bin/metadesk.mjs`). We honour it (never start a second engine
/// under a live launcher) but do not write it: single-instance for the shell is
/// the Tauri plugin's named mutex, and one file with two writers is confusion.
/// Only `launcherPid` matters here.
#[derive(Debug, Clone, Deserialize)]
pub struct InstanceLock {
    #[serde(rename = "launcherPid")]
    pub launcher_pid: u32,
}

/// What the launch sweep found on disk (step 0).
pub enum SweepOutcome {
    /// Nothing in the way, residue swept.
    Clear,
    /// Residue was swept; details are in the log.
    Swept(String),
    /// A live dev launcher owns the engine (live `instance.lock` launcher pid
    /// running a node.exe that is NOT ours). Do not start; do not kill.
    OwnedByLauncher { launcher_pid: u32 },
}

/// Everything the shell needs to own the engine for its whole life. Lives in
/// Tauri managed state.
pub struct EngineState {
    pub data_dir: PathBuf,
    pub node_exe: PathBuf,
    pub bundle_path: PathBuf,
    pub child: Mutex<Option<Child>>,
    /// The stop channel. `take()` + drop closes the pipe -> the server's
    /// graceful ladder runs (watcher, SSE hub, engine session).
    pub stdin_pipe: Mutex<Option<ChildStdin>>,
    pub server_pid: Mutex<Option<u32>>,
    /// Kept for the shell's whole life: dropping the Job handle is what kills
    /// the tree, so it must happen only at process exit.
    pub job: Mutex<Option<EngineJob>>,
    /// True once the deliberate stop started, so the crash watcher stays quiet.
    pub stopping: AtomicBool,
    /// True once a shutdown ladder has actually completed. The event loop waits
    /// for it before letting the process exit, so the ladder that a close click
    /// started on a worker thread is never cut short by the process going away.
    pub ladder_done: AtomicBool,
}

impl EngineState {
    pub fn new(data_dir: PathBuf, node_exe: PathBuf, bundle_path: PathBuf) -> Self {
        Self {
            data_dir,
            node_exe,
            bundle_path,
            child: Mutex::new(None),
            stdin_pipe: Mutex::new(None),
            server_pid: Mutex::new(None),
            job: Mutex::new(None),
            stopping: AtomicBool::new(false),
            ladder_done: AtomicBool::new(false),
        }
    }

    pub fn portfile_path(&self) -> PathBuf {
        self.data_dir.join(PORTFILE_NAME)
    }
}

// ---------------------------------------------------------------------------
// Step 0 — launch sweep
// ---------------------------------------------------------------------------

/// Sweep stale residue before anything is spawned, honouring the never-kill-a-
/// foreign-process rule.
pub fn launch_sweep(state: &EngineState) -> SweepOutcome {
    let mut swept: Vec<String> = Vec::new();

    // instance.lock first: a live dev launcher means the engine is not ours to
    // start or stop, whatever the portfile says.
    let lock_path = state.data_dir.join(LOCK_NAME);
    if let Some(lock) = read_json::<InstanceLock>(&lock_path) {
        let launcher_image = process_image_path(lock.launcher_pid);
        match launcher_image {
            None => {
                // Gone (or uninspectable): a lock whose pid is dead is stale.
                remove_file(&lock_path);
                swept.push(format!("stale instance.lock (launcher pid {} is gone)", lock.launcher_pid));
            }
            Some(image) => {
                // A live lock whose launcher runs A node.exe that is not ours is
                // a dev launcher (bin\metadesk.mjs) - never start a second
                // engine under it, never kill it. Any other image means the pid
                // was recycled since the lock was written: treat it as stale.
                let is_ours = image.eq_ignore_ascii_case(&state.node_exe.to_string_lossy());
                let is_a_node = image
                    .rsplit(['\\', '/'])
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case("node.exe"));
                if !is_ours && is_a_node {
                    return SweepOutcome::OwnedByLauncher {
                        launcher_pid: lock.launcher_pid,
                    };
                }
                if is_ours {
                    logging::line(
                        "sweep",
                        &format!(
                            "instance.lock points at pid {} running our own node.exe; ignoring the lock",
                            lock.launcher_pid
                        ),
                    );
                } else {
                    remove_file(&lock_path);
                    swept.push(format!(
                        "stale instance.lock (pid {} was recycled by {})",
                        lock.launcher_pid, image
                    ));
                }
            }
        }
    }

    if let Some(portfile) = read_json::<Portfile>(&state.portfile_path()) {
        match process_image_path(portfile.pid) {
            None => {
                remove_file(&state.portfile_path());
                swept.push(format!(
                    "stale portfile (pid {} is dead)",
                    portfile.pid
                ));
            }
            Some(image) => {
                let is_ours = image.eq_ignore_ascii_case(&state.node_exe.to_string_lossy());
                if is_ours {
                    logging::line(
                        "sweep",
                        &format!(
                            "portfile pid {} is a live engine from a dead shell; tree-killing and sweeping",
                            portfile.pid
                        ),
                    );
                    taskkill_tree(portfile.pid);
                    wait_until_dead(portfile.pid, ESCALATION_WINDOW);
                    remove_file(&state.portfile_path());
                    swept.push(format!("orphan engine pid {}", portfile.pid));
                } else {
                    logging::line(
                        "sweep",
                        &format!(
                            "portfile pid {} is alive but runs '{}' which is not our node.exe - left untouched",
                            portfile.pid, image
                        ),
                    );
                }
            }
        }
    }

    if swept.is_empty() {
        SweepOutcome::Clear
    } else {
        SweepOutcome::Swept(swept.join("; "))
    }
}

// ---------------------------------------------------------------------------
// Step 1 — spawn
// ---------------------------------------------------------------------------

/// Spawn the bundled node + server bundle as a DIRECT child: argv array, every
/// stream piped, no console, `METADESK_DATA_DIR` pinned, inherited
/// `METADESK_*` knobs stripped so a stray user environment cannot redirect the
/// shipped engine. The `Child`, its stdin pipe and its Job Object all stay in
/// managed state; the pid is returned for logging.
pub fn spawn_engine(state: &EngineState) -> Result<u32, String> {
    let mut command = Command::new(&state.node_exe);
    command
        .arg(&state.bundle_path)
        .current_dir(
            state
                .bundle_path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .env("METADESK_DATA_DIR", &state.data_dir)
        .env_remove("METADESK_PORT")
        .env_remove("METADESK_TOKEN")
        .env_remove("METADESK_EXIFTOOL")
        .env_remove("METADESK_SSE_HEARTBEAT_MS");

    logging::line(
        "spawn",
        &format!(
            "argv: {:?} {:?} (shell: false, CREATE_NO_WINDOW)",
            state.node_exe, state.bundle_path
        ),
    );

    let mut child = command.spawn().map_err(|error| {
        format!(
            "could not start the MetaDesk engine ({}): {error}",
            state.node_exe.display()
        )
    })?;

    // The stdin handle is the stop channel: it moves out of the Child into
    // managed state and is only ever dropped on purpose.
    if let Some(pipe) = child.stdin.take() {
        *state.stdin_pipe.lock().expect("stdin lock") = Some(pipe);
    }

    // Kernel backstop FIRST (while we still hold every handle we need), then
    // the streams, then the pid of record.
    let job_result = EngineJob::assign(&child);
    pipe_streams_to_log(&mut child);
    let pid = child.id();
    *state.child.lock().expect("child lock") = Some(child);
    *state.server_pid.lock().expect("pid lock") = Some(pid);
    logging::line("spawn", &format!("engine pid {pid}"));

    match job_result {
        Ok(job) => {
            *state.job.lock().expect("job lock") = Some(job);
            logging::line("spawn", "child assigned to a kill-on-close Job Object");
        }
        Err(error) => logging::line(
            "WARN",
            &format!(
                "Job Object assignment failed ({error}); the kernel backstop is OFF for this run"
            ),
        ),
    }

    // A stop (window close / tray Quit) that begins while a boot or a Reopen is
    // still spawning must not leave a fresh engine behind. The Job Object would
    // kill it when the process exits anyway, but run the ladder's core on it
    // now so nothing depends on that timing. Whichever of the two ladders takes
    // the pipe first wins; the other finds an empty slot and moves on.
    if state.stopping.load(Ordering::SeqCst) {
        logging::line(
            "spawn",
            "a stop started while the engine was spawning; stopping the fresh engine",
        );
        let pipe = state.stdin_pipe.lock().expect("stdin lock").take();
        drop(pipe);
        let mut child = state.child.lock().expect("child lock").take();
        if let Some(child) = child.as_mut() {
            wait_for_exit_or_escalate(child, Some(pid));
        }
        // The fresh portfile names a pid that is now stopping; the next launch's
        // step-0 sweep owns it (this only happens on the way out of the app).
        return Err("MetaDesk is shutting down; the engine was not started".to_string());
    }

    Ok(pid)
}

/// True while the child is still running. `None` = no child recorded.
pub fn child_running(state: &EngineState) -> Option<Option<i32>> {
    let mut guard = state.child.lock().expect("child lock");
    match guard.as_mut() {
        None => None,
        Some(child) => match child.try_wait() {
            Ok(status) => Some(status.and_then(|status| status.code())),
            Err(_) => Some(Some(-1)),
        },
    }
}

/// Give the spawned child's stdout/stderr to the log file, one thread each.
pub fn pipe_streams_to_log(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || pipe_to_log(stdout, "engine"));
    }
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || pipe_to_log(stderr, "engine.err"));
    }
}

fn pipe_to_log<R: Read + Send + 'static>(stream: R, scope: &'static str) {
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        match line {
            Ok(text) => {
                let text = text.trim_end();
                if !text.is_empty() {
                    logging::line(scope, text);
                }
            }
            Err(_) => break,
        }
    }
    logging::line(scope, "<stream closed>");
}

// ---------------------------------------------------------------------------
// Step 2 — health gate
// ---------------------------------------------------------------------------

pub struct HealthAnswer {
    pub portfile: Portfile,
    /// `ok:false` means the engine is degraded: NOT a boot failure (the server
    /// boots read-only by design) but worth a loud log line.
    pub engine_ok: bool,
    pub engine_version: String,
    pub reason: String,
}

/// Poll for the portfile and a 200 from `/api/health` (token-exempt by pinned
/// contract) until the deadline. The port only exists once the server has
/// bound, so the portfile is discovered first and the endpoint polled after.
pub fn wait_for_health(state: &EngineState) -> Result<HealthAnswer, String> {
    let started = Instant::now();
    let mut portfile: Option<Portfile> = None;

    while started.elapsed() < HEALTH_DEADLINE {
        if let Some(Some(code)) = child_running(state) {
            return Err(format!(
                "the MetaDesk engine exited before it started listening (exit code {code}); see the log for its output"
            ));
        }
        if portfile.is_none() {
            portfile = read_json::<Portfile>(&state.portfile_path());
        }
        if let Some(candidate) = &portfile {
            if let Some((status, body)) = http_get(candidate.port, "/api/health") {
                if status == 200 {
                    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                    return Ok(HealthAnswer {
                        portfile: candidate.clone(),
                        engine_ok: parsed["ok"].as_bool().unwrap_or(false),
                        engine_version: parsed["version"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                        reason: parsed["reason"].as_str().unwrap_or_default().to_string(),
                    });
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    Err(format!(
        "the MetaDesk engine did not answer its health check within {} s (portfile: {})",
        HEALTH_DEADLINE.as_secs(),
        match &portfile {
            Some(found) => format!("found, port {}", found.port),
            None => "never appeared".to_string(),
        }
    ))
}

// ---------------------------------------------------------------------------
// Steps 3-5 — the deliberate stop
// ---------------------------------------------------------------------------

/// Drop the stdin pipe, wait out the grace window, escalate to a tree kill,
/// then sweep the residue. Idempotent and safe to call twice; sets
/// `ladder_done` when it has finished so the event loop knows it can exit.
pub fn shutdown(state: &EngineState, reason: &str) {
    if state.stopping.swap(true, Ordering::SeqCst) {
        return;
    }
    logging::line("stop", &format!("shutdown ladder entered ({reason})"));

    // 3. Drop the stop channel. Closing the pipe is the established Windows
    //    stop channel; the server's own onClose ladder does the rest.
    let pipe = {
        let mut guard = state.stdin_pipe.lock().expect("stdin lock");
        guard.take()
    };
    if pipe.is_some() {
        drop(pipe);
        logging::line("stop", "engine stdin pipe closed (graceful stop requested)");
    }

    // 4. Grace poll on the child handle we hold — exact, not guessed. (The
    //    child lock is taken in its own scope: holding it across the poll would
    //    deadlock the second lock below.)
    let pid = *state.server_pid.lock().expect("pid lock");
    let mut child = {
        let mut guard = state.child.lock().expect("child lock");
        guard.take()
    };
    if let Some(child) = child.as_mut() {
        wait_for_exit_or_escalate(child, pid);
    }

    // Sweep the residue we own: the portfile naming a dead pid is noise a
    // future launch would otherwise have to sweep.
    if let Some(pid) = pid {
        if !pid_alive(pid) {
            if let Some(portfile) = read_json::<Portfile>(&state.portfile_path()) {
                if portfile.pid == pid {
                    remove_file(&state.portfile_path());
                    logging::line("stop", "portfile swept");
                }
            }
        } else {
            logging::line(
                "WARN",
                &format!("engine pid {pid} is STILL RUNNING after the shutdown ladder"),
            );
        }
    }
    // Put the child handle back (harmless if it is still running) before the
    // flag that lets the process exit.
    if let Some(child) = child {
        *state.child.lock().expect("child lock") = Some(child);
    }
    state.ladder_done.store(true, Ordering::SeqCst);
    logging::line("stop", "shutdown ladder complete");
}

/// Steps 4-5 on one already-taken child handle: grace-poll the handle we hold
/// (exact, not guessed), then escalate to a tree kill when the stop channel was
/// ignored. Shared by the shutdown ladder and by spawn's fresh-engine guard so
/// the escalation behaviour can never drift between the two.
fn wait_for_exit_or_escalate(child: &mut Child, pid: Option<u32>) {
    let deadline = Instant::now() + GRACE_WINDOW;
    let mut exited = false;
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map(|status| status.is_some())
            .unwrap_or(true)
        {
            exited = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if exited {
        logging::line("stop", "engine exited inside the grace window");
    } else if let Some(pid) = pid {
        // 5. Escalate: tree kill so the engine's own child dies too.
        logging::line(
            "WARN",
            &format!("engine pid {pid} ignored the graceful stop; escalating to taskkill /T /F"),
        );
        taskkill_tree(pid);
        wait_until_dead(pid, ESCALATION_WINDOW);
    }
}

// ---------------------------------------------------------------------------
// Process and network primitives
// ---------------------------------------------------------------------------

/// Kernel-guaranteed teardown: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` means the
/// node.exe + exiftool.exe tree dies the moment this shell's last Job handle
/// closes — including on a violent death that never reaches the ladder.
pub struct EngineJob {
    handle: SendableHandle,
}

/// A raw Win32 handle that lives in Tauri managed state (`Send` + `Sync`).
/// Sound here because the handle is only ever closed, and only at drop; no
/// other thread dereferences it.
struct SendableHandle(HANDLE);

unsafe impl Send for SendableHandle {}
unsafe impl Sync for SendableHandle {}

impl EngineJob {
    fn assign(child: &Child) -> Result<EngineJob, String> {
        unsafe {
            let handle = CreateJobObjectW(None, PWSTR::null())
                .map_err(|error| format!("CreateJobObjectW: {error}"))?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = CloseHandle(handle);
                return Err(format!("SetInformationJobObject: {error}"));
            }
            if let Err(error) = AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle())) {
                let _ = CloseHandle(handle);
                return Err(format!("AssignProcessToJobObject: {error}"));
            }
            Ok(EngineJob {
                handle: SendableHandle(handle),
            })
        }
    }
}

impl Drop for EngineJob {
    fn drop(&mut self) {
        // Closing the handle is the kill switch: only the OS does this at
        // process exit (the state that holds it is never dropped early).
        unsafe {
            let _ = CloseHandle(self.handle.0);
        }
    }
}

/// Is `pid` alive? `STILL_ACTIVE` is checked because a finished-but-attached
/// process object can still be opened.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            // Cannot inspect: report dead. The sweep additionally requires the
            // image path to match before it ever kills, so a wrong "dead" here
            // can only ever lead to an unlink, never a kill.
            Err(_) => return false,
        };
        let mut exit_code: u32 = 0;
        let result = GetExitCodeProcess(handle, &mut exit_code);
        let _ = CloseHandle(handle);
        match result {
            Ok(()) => exit_code == STILL_ACTIVE.0 as u32,
            Err(_) => false,
        }
    }
}

/// Full image path of `pid`, or None when it cannot be inspected (gone, or not
/// ours to look at). This is what makes the sweep safe.
pub fn process_image_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

/// `taskkill /PID <pid> /T /F` — argv array, no shell string. Used only after
/// the graceful window expires, and only at pids we have proven are ours.
pub fn taskkill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn wait_until_dead(pid: u32, window: Duration) {
    let deadline = Instant::now() + window;
    while pid_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    if pid_alive(pid) {
        logging::line("WARN", &format!("pid {pid} is still alive after the kill window"));
    }
}

/// Minimal loopback HTTP GET: status line plus a small body. No HTTP client
/// dependency — the only endpoints the shell ever touches are the token-exempt
/// health check and (for SPIKE evidence) the served page.
pub fn http_get(port: u16, path: &str) -> Option<(u16, String)> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok()?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: */*\r\nConnection: close\r\nUser-Agent: MetaDesk-Shell\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let text = String::from_utf8_lossy(&response);
    let mut parts = text.split("\r\n\r\n");
    let head = parts.next()?;
    let body = parts.next().unwrap_or_default().to_string();
    let status_line = head.lines().next()?;
    let status: u16 = status_line.split_whitespace().nth(1)?.parse().ok()?;
    Some((status, body))
}

// ---------------------------------------------------------------------------
// Small disk helpers
// ---------------------------------------------------------------------------

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn remove_file(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => logging::line("sweep", &format!("removed {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => logging::line(
            "WARN",
            &format!("could not remove {}: {error}", path.display()),
        ),
    }
}
