//! Branded native error dialogs (plain Win32 `MessageBoxW`).
//!
//! No dialog plugin: these are shell-side, never webview-side, so they need no
//! capability surface. Every dialog names what failed and where the log is, per
//! the pinned failure ladder. They BLOCK the calling thread, so callers run
//! them off the event-loop thread (or accept that nothing else matters, which
//! is the case for boot failures).

use windows::core::PCWSTR;
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_SYSTEMMODAL,
    MB_TOPMOST,
};

pub const APP_TITLE: &str = "MetaDesk";
pub const WEBVIEW2_DOWNLOAD: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// Blocking error dialog (boot failures, engine stopped). Returns after the
/// user dismisses it.
pub fn error(text: &str) {
    message_box(text, MB_ICONERROR);
}

/// Blocking warning dialog (recoverable situations).
pub fn warning(text: &str) {
    message_box(text, MB_ICONWARNING);
}

fn message_box(text: &str, icon: windows::Win32::UI::WindowsAndMessaging::MESSAGEBOX_STYLE) {
    let wide_text = to_wide(text);
    let wide_title = to_wide(APP_TITLE);
    unsafe {
        let _ = MessageBoxW(
            None,
            PCWSTR(wide_text.as_ptr()),
            PCWSTR(wide_title.as_ptr()),
            MB_OK | MB_SETFOREGROUND | MB_TOPMOST | MB_SYSTEMMODAL | icon,
        );
    }
}

/// Fatal boot failure: dialog, then exit non-zero. The caller has already run
/// the shutdown ladder for anything it spawned.
pub fn fatal(text: &str, exit_code: i32) -> ! {
    error(text);
    std::process::exit(exit_code);
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
