mod shell;
mod system;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            shell::open_properties,
            shell::shell_delete,
            shell::shell_move,
            shell::shell_context_menu,
            shell::shell_verbs,
            shell::shell_invoke_verb,
            system::get_autostart,
            system::set_close_behavior,
            system::set_autostart,
            system::set_tray_visible,
            system::set_folder_handler,
            system::open_default_apps
        ])
        .manage(system::ServiceProcess(std::sync::Mutex::new(None)))
        .manage(system::TrayHandle(std::sync::Mutex::new(None)))
        .manage(system::CloseBehavior(std::sync::atomic::AtomicBool::new(
            true,
        )))
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || system::ensure_service(&handle));
            let tray = system::build_tray(app.handle())?;
            let state = app.handle().state::<system::TrayHandle>();
            if let Ok(mut slot) = state.0.lock() {
                *slot = Some(tray);
            }
            Ok(())
        })
        .on_window_event(|window, event| system::handle_window_event(window, event))
        .build(tauri::generate_context!())
        .expect("error while building Oriel")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                system::shutdown(app);
            }
        });
}
