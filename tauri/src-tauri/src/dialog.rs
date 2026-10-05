//! Branded native error dialogs (plain Win32 `MessageBoxW`, plus one
//! `TaskDialogIndirect` for the crash dialog's custom Reopen / Quit buttons).
//!
//! No dialog plugin: these are shell-side, never webview-side, so they need no
//! capability surface. Every dialog names what failed and where the log is, per
//! the pinned failure ladder. They BLOCK the calling thread, so callers run
//! them off the event-loop thread (or accept that nothing else matters, which
//! is the case for boot failures).

use windows::core::PCWSTR;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Controls::{
    TaskDialogIndirect, TD_WARNING_ICON, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TASKDIALOG_BUTTON,
    TDF_ALLOW_DIALOG_CANCELLATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_SYSTEMMODAL, MB_TOPMOST,
    MB_YESNO,
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

/// What the user asked for after the engine died (ladder step 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashChoice {
    /// Start the engine again and reload the open window. Never chosen for the
    /// user — the dialog is the only thing that can trigger a restart.
    Reopen,
    /// Run the shutdown ladder and exit.
    Quit,
}

// Custom button ids for the TaskDialog (ids < 100 are reserved for common
// buttons such as IDOK/IDCANCEL).
const BUTTON_REOPEN: i32 = 1001;
const BUTTON_QUIT: i32 = 1002;

/// Ladder step 7's native dialog: "MetaDesk's engine stopped unexpectedly",
/// with the pinned Reopen / Quit affordances (never a silent auto-restart).
/// Rendered as a TaskDialog so the buttons can say Reopen and Quit instead of
/// Yes / No; if that fails on this machine it falls back to a plain Yes/No
/// message box where Yes means Reopen.
pub fn engine_stopped(exit_code: i32, log_path: &str) -> CrashChoice {
    let content = format!(
        "MetaDesk's engine stopped unexpectedly (exit code {exit_code}).\n\n\
         Your photos are safe: MetaDesk never writes without your approval, and \
         every write is journalled and backed up before it lands.\n\n\
         Details: {log_path}\n\n\
         Reopen starts the engine again and reloads this window. Quit closes MetaDesk."
    );

    match task_dialog_reopen_or_quit(&content) {
        Some(choice) => choice,
        None => {
            // Fallback: the plain message box. Keep the meaning explicit in the
            // text so Yes / No is never ambiguous.
            let fallback = format!("{content}\n\n(Yes = Reopen, No = Quit)");
            let wide_text = to_wide(&fallback);
            let wide_title = to_wide(APP_TITLE);
            let answer = unsafe {
                MessageBoxW(
                    None,
                    PCWSTR(wide_text.as_ptr()),
                    PCWSTR(wide_title.as_ptr()),
                    MB_YESNO | MB_SETFOREGROUND | MB_TOPMOST | MB_SYSTEMMODAL | MB_ICONWARNING,
                )
            };
            if answer == windows::Win32::UI::WindowsAndMessaging::IDYES {
                CrashChoice::Reopen
            } else {
                CrashChoice::Quit
            }
        }
    }
}

/// The Common Controls v6 task dialog with custom Reopen / Quit buttons.
/// Returns `None` when the dialog could not be shown (caller falls back).
fn task_dialog_reopen_or_quit(content: &str) -> Option<CrashChoice> {
    // TaskDialogIndirect requires COM on the calling thread. It is already
    // initialized on the event-loop thread; the crash watcher thread needs its
    // own apartment. A failure here (already initialized in another mode) is
    // fine — the dialog itself decides whether things worked.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let wide_title = to_wide(APP_TITLE);
    let wide_instruction = to_wide("MetaDesk's engine stopped unexpectedly");
    let wide_content = to_wide(content);
    let wide_reopen = to_wide("Reopen");
    let wide_quit = to_wide("Quit");

    // The struct is packed(1) in the Windows SDK, so build every field
    // explicitly instead of using struct-update syntax (which cannot read out
    // of a packed struct).
    let buttons = [
        TASKDIALOG_BUTTON {
            nButtonID: BUTTON_REOPEN,
            pszButtonText: PCWSTR(wide_reopen.as_ptr()),
        },
        TASKDIALOG_BUTTON {
            nButtonID: BUTTON_QUIT,
            pszButtonText: PCWSTR(wide_quit.as_ptr()),
        },
    ];
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: Default::default(),
        hInstance: Default::default(),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
        dwCommonButtons: Default::default(),
        pszWindowTitle: PCWSTR(wide_title.as_ptr()),
        Anonymous1: TASKDIALOGCONFIG_0 {
            pszMainIcon: TD_WARNING_ICON,
        },
        pszMainInstruction: PCWSTR(wide_instruction.as_ptr()),
        pszContent: PCWSTR(wide_content.as_ptr()),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: BUTTON_REOPEN,
        cRadioButtons: 0,
        pRadioButtons: std::ptr::null(),
        nDefaultRadioButton: 0,
        pszVerificationText: PCWSTR::null(),
        pszExpandedInformation: PCWSTR::null(),
        pszExpandedControlText: PCWSTR::null(),
        pszCollapsedControlText: PCWSTR::null(),
        Anonymous2: Default::default(),
        pszFooter: PCWSTR::null(),
        pfCallback: None,
        lpCallbackData: 0,
        cxWidth: 0,
    };

    let mut chosen: i32 = 0;
    let result = unsafe { TaskDialogIndirect(&config, Some(&mut chosen), None, None) };
    match result {
        Ok(()) if chosen == BUTTON_REOPEN => Some(CrashChoice::Reopen),
        // Anything else (Quit, Esc / cancel) means: do not restart.
        Ok(()) => Some(CrashChoice::Quit),
        Err(_) => None,
    }
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
