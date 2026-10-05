//! The shell's log file.
//!
//! One append-only file under the data dir (`metadesk-shell.log`) carries both
//! the shell's own lines and everything the bundled engine writes to stdout and
//! stderr. It is the single artifact a support conversation is pointed at, and
//! the file the boot-failure dialogs name.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Open (or create) the log inside `data_dir`. A failure to open it is not
/// fatal: the shell still runs, it just logs nowhere — but the path is
/// remembered so dialogs can name it.
pub fn init(data_dir: &Path) {
    let path = data_dir.join("metadesk-shell.log");
    let _ = LOG_PATH.set(path.clone());
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok();
    let _ = LOG_FILE.set(Mutex::new(file));
}

pub fn path() -> PathBuf {
    LOG_PATH.get().cloned().unwrap_or_else(|| PathBuf::from("<log not opened>"))
}

/// Append one line. `scope` is a short tag (`shell`, `engine`, `sweep`, ...).
pub fn line(scope: &str, message: &str) {
    let text = format!("[{}] [{scope}] {message}\n", timestamp());
    if let Some(mutex) = LOG_FILE.get() {
        if let Ok(mut guard) = mutex.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = file.write_all(text.as_bytes());
                let _ = file.flush();
            }
        }
    }
    // In debug builds the same lines reach the developer console; release
    // builds have no console at all (windows_subsystem = "windows").
    #[cfg(debug_assertions)]
    {
        print!("{text}");
        let _ = std::io::stdout().flush();
    }
}

/// UTC ISO-8601 timestamp with milliseconds, no external time crate.
fn timestamp() -> String {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since_epoch.as_secs();
    let millis = since_epoch.subsec_millis();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rest = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z",
        h = rest / 3_600,
        m = (rest % 3_600) / 60,
        s = rest % 60,
    )
}

/// Days-since-epoch to (year, month, day). Howard Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}
