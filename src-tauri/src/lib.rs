mod shell;
mod system;

use std::path::Path;
use std::sync::atomic::Ordering;

use tauri::{Manager, RunEvent};

fn startup_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| Path::new(arg).is_dir())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hidden = std::env::args().any(|arg| arg == "--hidden" || arg == "-hidden");
    let paths = startup_paths();

    tauri::Builder::default()
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
            system::open_default_apps,
            system::restart_service,
            system::take_startup_paths,
            system::install_update
        ])
        .manage(system::ServiceProcess(std::sync::Mutex::new(None)))
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
