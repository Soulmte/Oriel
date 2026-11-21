mod shell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            shell::open_properties,
            shell::shell_delete,
            shell::shell_move,
            shell::shell_context_menu,
            shell::shell_verbs,
            shell::shell_invoke_verb
        ])
        .run(tauri::generate_context!())
        .expect("error while running Oriel");
}
