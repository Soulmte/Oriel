mod shell;
mod system;

use std::path::Path;
use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager, RunEvent};

/// Shells quote `%1` and some programs append a trailing separator, which
/// leaves a stray quote or backslash in argv (`D:\dir\"` arrives as
/// `D:\dir\"` minus the opening quote). Clean it up before probing the disk.
fn path_arg(raw: &str) -> Option<String> {
    let cleaned = raw.trim().trim_matches('"').trim();
    if cleaned.is_empty() || cleaned.starts_with('-') {
        return None;
    }

    let path = Path::new(cleaned);
    if path.is_dir() {
        return Some(cleaned.to_string());
    }
    // A file target (path link to a document) opens the folder that holds it.
    if path.is_file() {
        return path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.to_string_lossy().to_string());
    }
    None
}

fn startup_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter_map(|arg| path_arg(&arg))
        .collect()
}

fn elevate_helper_arg() -> Option<u32> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--elevate-helper" {
            return args.next().and_then(|value| value.parse().ok());
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The elevation helper is a second launch of this exe: it waits for the old
    // process to exit and then relaunches Oriel with a UAC prompt. It must not
    // start Tauri, or the single-instance plugin would forward it and quit.
    if let Some(pid) = elevate_helper_arg() {
        system::run_elevate_helper(pid);
        return;
    }

    let hidden = std::env::args().any(|arg| arg == "--hidden" || arg == "-hidden");
    let paths = startup_paths();

    tauri::Builder::default()
        // Opening Oriel again (desktop shortcut, folder handler) must focus the
        // running window instead of starting a second tray/service process.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let target = args
                .iter()
                .skip(1)
                .find_map(|arg| path_arg(arg));
            if let Some(target) = target {
                let _ = app.emit("oriel:open-path", target);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            shell::open_properties,
            shell::shell_delete,
            shell::shell_move,
            shell::shell_context_menu,
            shell::shell_verbs,
            shell::shell_invoke_verb,
            system::get_autostart,
            system::get_shell_prefs,
            system::set_close_behavior,
            system::set_autostart,
            system::set_tray_visible,
            system::set_folder_handler,
            system::set_default_file_manager,
            system::open_log_folder,
            system::restart_service,
            system::relaunch_elevated,
            system::take_startup_paths,
            system::install_update
        ])
        .manage(system::TrayHandle(std::sync::Mutex::new(None)))
        .manage(system::CloseBehavior(std::sync::atomic::AtomicBool::new(
            true,
        )))
        .manage(system::StartupPaths(std::sync::Mutex::new(paths)))
        .setup(move |app| {
            // Preferences are applied before the first frame: a user who hid
            // the tray icon should never see it flash back on launch, and an
            // autostart launch must not steal focus.
            let prefs = system::read_shell_prefs(app.handle());
            app.state::<system::CloseBehavior>()
                .0
                .store(prefs.close_to_tray, Ordering::Relaxed);

            let handle = app.handle().clone();
            std::thread::spawn(move || system::ensure_service(&handle));
            // Fix associations written by 0.1.8 (it put the empty DelegateExecute
            // on the wrong key, so folders still opened in Explorer).
            std::thread::spawn(system::repair_default_handler);

            if prefs.tray {
                let tray = system::build_tray(app.handle())?;
                {
                    let state = app.handle().state::<system::TrayHandle>();
                    let mut slot = state
                        .0
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    *slot = Some(tray);
                }
            }

            // The window is created hidden so the first paint happens with the
            // fonts and colours already settled. Show it unless this launch
            // came from the autostart entry and a tray icon can bring it back.
            if !(hidden && prefs.tray) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| system::handle_window_event(window, event))
        .build(tauri::generate_context!())
        .expect("error while building Oriel")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                system::shutdown(app);
            }
        });
}
