//! Everything the packaged app needs from the OS itself.
//!
//! The web UI is only half of a file manager: the service that reads the disk
//! has to run before the window is useful, the window has to survive a close to
//! tray, and Windows has to be told that Oriel exists as a handler. This module
//! owns that: it boots the embedded Rust service, exposes tray/autostart/handler
//! toggles as commands, and keeps the shell integration together.

use std::net::TcpStream;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

/// Tray icon handle, kept so the UI can hide/show it at runtime.
pub struct TrayHandle(pub Mutex<Option<TrayIcon>>);

/// Whether closing the window hides it (true) or quits (false). Owned by the
/// front end through `set_close_behavior`, read by the close handler.
pub struct CloseBehavior(pub AtomicBool);

/// Paths passed on the command line (`Oriel.exe "C:\\Users"`), consumed by the
/// front end once the service is up so a folder double-click lands in Oriel.
pub struct StartupPaths(pub Mutex<Vec<String>>);

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Oriel";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const UPDATE_DIR: &str = "oriel-updates";

/// Persisted shell preferences. localStorage belongs to the webview and is not
/// readable before the window exists, so the tray/close choices live here where
/// the Rust side can apply them on the very first boot.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellPrefs {
    #[serde(default = "default_true")]
    pub tray: bool,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
}

fn default_true() -> bool {
    true
}

impl Default for ShellPrefs {
    fn default() -> Self {
        Self {
            tray: true,
            close_to_tray: true,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellPrefsDto {
    tray: bool,
    close_to_tray: bool,
    autostart: bool,
    folder_handler: bool,
    default_handler: bool,
}

/// Tauri resolves paths with the verbatim `\\?\` prefix, which Node's ESM
/// loader does not understand; strip it before handing paths to the service.
fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

fn api_port() -> u16 {
    std::env::var("ORIEL_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787)
}

fn api_ready(port: u16) -> bool {
    let address = format!("127.0.0.1:{port}");
    let Ok(socket) = address.parse() else {
        return false;
    };
    TcpStream::connect_timeout(&socket, Duration::from_millis(180)).is_ok()
}

/// Version reported by a live service on `port`, or `None` when the listener is
/// gone or is not answering our health endpoint.
///
/// A plain connect is not enough: right after an elevation restart the old
/// process can still hold the port for a moment, and a half-dead service would
/// leave every later request hanging.
fn health_version(port: u16) -> Option<String> {
    use std::io::{Read, Write};

    let address = format!("127.0.0.1:{port}");
    let socket = address.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_millis(400)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;

    let mut buffer = String::new();
    (&mut stream).take(4096).read_to_string(&mut buffer).ok()?;
    let start = buffer.find("\"version\"")?;
    let rest = &buffer[start + "\"version\"".len()..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

fn wait_for_port_to_free(port: u16, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if !api_ready(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    !api_ready(port)
}

/// Starts the embedded service unless a matching one already answers.
pub fn ensure_service(app: &AppHandle) {
    let port = api_port();
    let expected = app.package_info().version.to_string();

    if let Some(version) = health_version(port) {
        if version == expected {
            log("service already running");
            return;
        }
        log(&format!(
            "stale service {version} on {port}, waiting for it to exit"
        ));
        wait_for_port_to_free(port, Duration::from_secs(10));
    } else if api_ready(port) {
        // Something listens but does not answer `/api/health`: most likely the
        // previous instance finishing its shutdown.
        log(&format!("port {port} held by an unresponsive listener"));
        wait_for_port_to_free(port, Duration::from_secs(10));
    }

    for attempt in 1..=3 {
        // The updater reads its mirror settings from `option_env!` in
        // oriel-service; do not shadow them with runtime overrides here.
        let state = oriel_service::AppState::new(port, expected.clone());
        tauri::async_runtime::spawn(async move {
            let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            if let Err(error) = oriel_service::serve(state, address).await {
                log(&format!("service stopped: {error}"));
            }
        });

        // Wait briefly so the first paint already has a live service.
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if health_version(port).as_deref() == Some(expected.as_str()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(120));
        }

        log(&format!("service did not answer on attempt {attempt}"));
        wait_for_port_to_free(port, Duration::from_secs(3));
    }
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("shell.json"))
}

pub fn read_shell_prefs(app: &AppHandle) -> ShellPrefs {
    let Some(path) = prefs_path(app) else {
        return ShellPrefs::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<ShellPrefs>(&text).ok())
        .unwrap_or_default()
}

fn write_shell_prefs(app: &AppHandle, prefs: &ShellPrefs) {
    let Some(path) = prefs_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(path, text);
    }
}

fn update_shell_prefs(app: &AppHandle, update: impl FnOnce(&mut ShellPrefs)) {
    let mut prefs = read_shell_prefs(app);
    update(&mut prefs);
    write_shell_prefs(app, &prefs);
}

fn registry_key_exists(key: &str) -> bool {
    reg(&["query", key])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// `reg.exe` is a console program: without this flag every toggle flashes a
/// black window over the file manager.
fn reg(args: &[&str]) -> Command {
    let mut command = Command::new("reg");
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn log(message: &str) {
    // A packaged app has no console: leave a breadcrumb for support instead.
    if let Ok(dir) = std::env::var("TEMP") {
        let path = std::path::Path::new(&dir).join("oriel-sidecar.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            use std::io::Write;
            let _ = writeln!(file, "[{}] {message}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0));
        }
    }
}



/* ------------------------------------------------------------------ tray */

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Oriel", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

    TrayIconBuilder::with_id("oriel-tray")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Oriel")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)
}

/* ------------------------------------------------------------- commands */

#[derive(Serialize)]
pub struct AutostartState {
    enabled: bool,
    supported: bool,
}

fn current_exe_quoted() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    format!("\"{}\"", exe.display())
}

/// Autostart launches into the tray instead of stealing focus at login, so the
/// Run value carries `--hidden`; the Rust side honours it on the next start.
fn current_exe_for_run() -> String {
    format!("{} --hidden", current_exe_quoted())
}

#[tauri::command]
pub fn get_autostart() -> AutostartState {
    let enabled = reg(&["query", RUN_KEY, "/v", RUN_VALUE])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    AutostartState {
        enabled,
        supported: cfg!(windows),
    }
}

#[tauri::command]
pub fn get_shell_prefs(app: AppHandle) -> ShellPrefsDto {
    let prefs = read_shell_prefs(&app);
    ShellPrefsDto {
        tray: prefs.tray,
        close_to_tray: prefs.close_to_tray,
        autostart: get_autostart().enabled,
        folder_handler: registry_key_exists(r"HKCU\Software\Classes\Directory\shell\Oriel"),
        default_handler: default_handler_installed(),
    }
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    let status = if enabled {
        reg(&[
            "add",
            RUN_KEY,
            "/v",
            RUN_VALUE,
            "/t",
            "REG_SZ",
            "/d",
            &current_exe_for_run(),
            "/f",
        ])
        .status()
    } else {
        reg(&["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]).status()
    };

    status
        .map(|code| code.success())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_close_behavior(app: AppHandle, state: State<'_, CloseBehavior>, minimize: bool) {
    state.0.store(minimize, Ordering::Relaxed);
    update_shell_prefs(&app, |prefs| prefs.close_to_tray = minimize);
}

#[tauri::command]
pub fn set_tray_visible(
    app: AppHandle,
    state: State<'_, TrayHandle>,
    visible: bool,
) -> Result<(), String> {
    {
        let mut slot = state.0.lock().map_err(|error| error.to_string())?;
        if visible {
            if slot.is_none() {
                *slot = Some(build_tray(&app).map_err(|error| error.to_string())?);
            }
            if let Some(tray) = slot.as_ref() {
                let _ = tray.set_visible(true);
            }
        } else if let Some(tray) = slot.as_ref() {
            // Keep the handle so it can come back without a restart.
            let _ = tray.set_visible(false);
        }
    }
    update_shell_prefs(&app, |prefs| prefs.tray = visible);
    Ok(())
}

/// The service lives in this process, so "restart" means: drop cached icons and
/// bring the listener back if it ever died.
/// Restarts Oriel elevated. A small helper process waits for this instance to
/// exit, then asks Windows for elevation, so the single-instance guard never
/// sees two live windows. That is how Geek-like tools end up running as admin:
/// they ask once at startup instead of per action.
#[tauri::command]
pub fn relaunch_elevated(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    Command::new(&exe)
        .arg("--elevate-helper")
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("无法重启 Oriel：{error}"))?;
    app.exit(0);
    Ok(())
}

/// Entry point for the helper spawned by `relaunch_elevated`.
pub fn run_elevate_helper(parent_pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && oriel_core::apps::process_running(parent_pid) {
        std::thread::sleep(Duration::from_millis(250));
    }

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let verb = wide("runas");
    let file = wide(&exe.to_string_lossy());
    let mut info = windows::Win32::UI::Shell::SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<windows::Win32::UI::Shell::SHELLEXECUTEINFOW>() as u32,
        fMask: windows::Win32::UI::Shell::SEE_MASK_NOCLOSEPROCESS,
        lpVerb: windows::core::PCWSTR(verb.as_ptr()),
        lpFile: windows::core::PCWSTR(file.as_ptr()),
        nShow: windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe {
        let _ = windows::Win32::UI::Shell::ShellExecuteExW(&mut info);
        if !info.hProcess.is_invalid() {
            let _ = windows::Win32::Foundation::CloseHandle(info.hProcess);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[tauri::command]
pub fn restart_service(app: AppHandle) -> Result<(), String> {
    oriel_core::icons::clear_cache();
    let handle = app.clone();
    std::thread::spawn(move || ensure_service(&handle));
    Ok(())
}

#[tauri::command]
pub fn take_startup_paths(state: State<'_, StartupPaths>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut paths| std::mem::take(&mut *paths))
        .unwrap_or_default()
}

/// Downloads finish in `%TEMP%\oriel-updates`; only an installer from there may
/// be launched, so a compromised update feed cannot run arbitrary binaries.
#[tauri::command]
pub fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    let installer = plain(PathBuf::from(path));
    if !installer.is_file() {
        return Err("安装包已不存在，请重新下载".into());
    }
    let allowed = std::env::temp_dir().join(UPDATE_DIR);
    // Create it first: canonicalize fails with a bare OS error otherwise.
    let _ = std::fs::create_dir_all(&allowed);
    let canonical = std::fs::canonicalize(&installer).map_err(|error| error.to_string())?;
    let canonical_allowed = std::fs::canonicalize(&allowed).map_err(|error| error.to_string())?;
    if !canonical.starts_with(&canonical_allowed) {
        return Err("安装包不在更新目录中".into());
    }

    let ext = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let target = canonical.to_string_lossy().to_string();
    // Silent installs: the user already said yes in the update card, so the
    // installer should not walk them through uninstall/install pages again.
    let mut command = match ext.as_str() {
        "exe" => {
            let mut command = Command::new(&target);
            command.arg("/S");
            command
        }
        "msi" => {
            let mut command = Command::new("msiexec");
            command.args(["/i", &target, "/passive"]);
            command
        }
        _ => return Err("不支持的安装包类型".into()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;

    // Let the installer process start before this one releases its files.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        handle.exit(0);
    });
    Ok(())
}

pub fn tray_present(state: &State<'_, TrayHandle>) -> bool {
    state.0.lock().map(|slot| slot.is_some()).unwrap_or(false)
}

/// Folder handler registration. Windows has no supported way to replace
/// Explorer as the shell, so this adds Oriel to the folder context menu (and
/// the "打开方式" list) instead of hijacking `explorer.exe`, which would take
/// the taskbar and desktop with it.
#[tauri::command]
pub fn set_folder_handler(enabled: bool) -> Result<bool, String> {
    let exe = current_exe_quoted();
    let targets = [
        (r"HKCU\Software\Classes\Directory\shell\Oriel", "%1"),
        (r"HKCU\Software\Classes\Directory\Background\shell\Oriel", "%V"),
        (r"HKCU\Software\Classes\Drive\shell\Oriel", "%1"),
    ];

    for (key, argument) in targets {
        if enabled {
            let _ = reg(&[
                "add",
                key,
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                "用 Oriel 打开",
                "/f",
            ])
            .status();
            let _ = reg(&[
                "add",
                &format!("{key}\\Icon"),
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &exe,
                "/f",
            ])
            .status();
            let _ = reg(&[
                "add",
                &format!("{key}\\command"),
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &format!("{exe} \"{argument}\""),
                "/f",
            ])
            .status();
        } else {
            let _ = reg(&["delete", key, "/f"]).status();
        }
    }

    Ok(enabled)
}

#[tauri::command]
pub fn open_log_folder() -> Result<(), String> {
    let dir = std::env::temp_dir();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer")
            .arg(&dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        Err("仅支持 Windows".into())
    }
}

/// `Directory\shell\open` is the verb `ShellExecute` uses for real folders,
/// so pointing it at Oriel redirects "open this folder" calls made by other
/// programs. Explorer's own windows and Win+E navigate internally and stay with
/// Explorer: Windows has no API to replace the shell itself.
const DIRECTORY_OPEN_KEY: &str = r"HKCU\Software\Classes\Directory\shell\open\command";
const DRIVE_OPEN_KEY: &str = r"HKCU\Software\Classes\Drive\shell\open\command";
/// The `Folder` class is what the shell uses for the folder verbs it runs
/// itself. Windows ships those verbs with a `DelegateExecute` CLSID on the
/// `command` key, so the command line is only honoured once that value is
/// cleared there.
const FOLDER_VERB_KEYS: [&str; 2] = [
    r"HKCU\Software\Classes\Folder\shell\open",
    r"HKCU\Software\Classes\Folder\shell\explore",
];

/// Explorer's built-in folder verbs delegate through a COM CLSID stored on
/// `<verb>\command`. An empty `DelegateExecute` at that same key makes the shell
/// run the plain command line instead; the value on the verb key itself is
/// ignored. This is what makes the override visible to `ShellExecute`.
fn clear_delegate(command_key: &str) {
    let _ = reg(&[
        "add",
        command_key,
        "/v",
        "DelegateExecute",
        "/t",
        "REG_SZ",
        "/d",
        "",
        "/f",
    ])
    .status();
}

fn registry_default_value(key: &str) -> Option<String> {
    let output = reg(&["query", key, "/ve"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find(|line| line.contains("REG_SZ"))
        .and_then(|line| line.split("REG_SZ").nth(1))
        .map(|value| value.trim().to_string())
}

/// The shell caches verb resolution; without this the new association only
/// takes effect after an Explorer restart.
fn notify_shell_of_associations() {
    #[cfg(windows)]
    unsafe {
        windows::Win32::UI::Shell::SHChangeNotify(
            windows::Win32::UI::Shell::SHCNE_ASSOCCHANGED,
            windows::Win32::UI::Shell::SHCNF_IDLIST,
            None,
            None,
        );
    }
}

fn default_handler_installed() -> bool {
    let Some(name) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.file_name().map(|name| name.to_string_lossy().to_lowercase()))
    else {
        return false;
    };
    registry_default_value(DIRECTORY_OPEN_KEY)
        .map(|value| value.to_lowercase().contains(&name))
        .unwrap_or(false)
}

/// Re-applies the folder association when it is already ours. Older builds put
/// the empty `DelegateExecute` on the verb key instead of the command key, so
/// the switch looked on while `ShellExecute` still opened Explorer; running this
/// once per launch repairs that (and a stale exe path after an update).
pub fn repair_default_handler() {
    if default_handler_installed() {
        let _ = set_default_file_manager(true);
    }
}

/// Redirects the shell's folder-open verb to Oriel and registers it in the
/// "打开方式" list. Reverting deletes the per-user override, so folders fall
/// back to Explorer again.
#[tauri::command]
pub fn set_default_file_manager(enabled: bool) -> Result<bool, String> {
    let exe = current_exe_quoted();
    let prog_id = r"HKCU\Software\Classes\Oriel.Folder";

    if !enabled {
        for key in [
            r"HKCU\Software\Classes\Directory\shell\open",
            r"HKCU\Software\Classes\Drive\shell\open",
            r"HKCU\Software\Classes\Folder\shell\open",
            r"HKCU\Software\Classes\Folder\shell\explore",
            prog_id,
            r"HKCU\Software\Classes\Directory\OpenWithProgids\Oriel.Folder",
            r"HKCU\Software\Classes\Drive\OpenWithProgids\Oriel.Folder",
            r"HKCU\Software\Classes\Applications\Oriel.exe",
        ] {
            let _ = reg(&["delete", key, "/f"]).status();
        }
        notify_shell_of_associations();
        return Ok(false);
    }

    // Verify instead of trusting the exit code: a half-written key is worse
    // than a clear failure.
    for (index, key) in [DIRECTORY_OPEN_KEY, DRIVE_OPEN_KEY].iter().enumerate() {
        let status = reg(&[
            "add",
            key,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            &format!("{exe} \"%1\""),
            "/f",
        ])
        .status();
        let ok = status.map(|status| status.success()).unwrap_or(false);
        // The folder key is what actually takes over; the drive one is a bonus.
        if index == 0 && (!ok || !default_handler_installed()) {
            return Err("无法写入文件夹关联，请确认安全软件没有拦截注册表写入".into());
        }
        clear_delegate(key);
    }

    // The shell's own folder verbs: drop the stock delegate and point the
    // command line at Oriel.
    for key in FOLDER_VERB_KEYS {
        // 0.1.8 wrote the empty value one level too high; remove that stale one.
        let _ = reg(&["delete", key, "/v", "DelegateExecute", "/f"]).status();
        let command = format!("{key}\\command");
        let _ = reg(&[
            "add",
            &command,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            &format!("{exe} \"%1\""),
            "/f",
        ])
        .status();
        clear_delegate(&command);
    }

    // (key, value name — None means the key's default value, data)
    let entries: Vec<(String, Option<&str>, String)> = vec![
        (prog_id.to_string(), None, "Oriel 文件夹".into()),
        (
            format!("{prog_id}\\DefaultIcon"),
            None,
            format!("{exe},0"),
        ),
        (
            format!("{prog_id}\\shell\\open\\command"),
            None,
            format!("{exe} \"%1\""),
        ),
        (
            r"HKCU\Software\Classes\Directory\OpenWithProgids".into(),
            Some("Oriel.Folder"),
            String::new(),
        ),
        (
            r"HKCU\Software\Classes\Drive\OpenWithProgids".into(),
            Some("Oriel.Folder"),
            String::new(),
        ),
        (
            r"HKCU\Software\Classes\Applications\Oriel.exe".into(),
            Some("FriendlyAppName"),
            "Oriel".into(),
        ),
    ];

    for (key, name, value) in entries {
        let mut args: Vec<&str> = vec!["add", key.as_str()];
        match name {
            Some(name) => args.extend([
                "/v",
                name,
                "/t",
                "REG_SZ",
                "/d",
                value.as_str(),
                "/f",
            ]),
            None => args.extend([
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                value.as_str(),
                "/f",
            ]),
        }
        let _ = reg(&args).status();
    }

    // The Applications entry makes `Oriel.exe` appear under Open with…
    let _ = reg(&[
        "add",
        r"HKCU\Software\Classes\Applications\Oriel.exe\shell\open\command",
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        &format!("{exe} \"%1\""),
        "/f",
    ])
    .status();

    notify_shell_of_associations();
    Ok(true)
}

/* ----------------------------------------------------------------- setup */

pub fn shutdown(_app: &AppHandle) {
    // Nothing to tear down: the service is a task inside this process.
}

pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let minimize = app
            .try_state::<CloseBehavior>()
            .map(|state| state.0.load(Ordering::Relaxed))
            .unwrap_or(true);
        let keep = minimize
            && app
                .try_state::<TrayHandle>()
                .map(|state| tray_present(&state))
                .unwrap_or(false);
        // With a tray icon present, closing hides: the service keeps running and
        // the next launch is instant. Quitting is explicit, from the tray menu.
        if keep {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The association is only reported as installed when the value we just
    /// wrote parses back, so a broken parser would make the switch fail on
    /// every attempt.
    #[test]
    fn registry_value_round_trips() {
        let key = r"HKCU\Software\Classes\Oriel.TestProbe";
        let value = r#""C:\Program Files\Oriel\oriel.exe" "%1""#;
        let status = reg(&["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"])
            .status();
        if !status.map(|status| status.success()).unwrap_or(false) {
            // No registry access in this environment; nothing to assert.
            return;
        }

        let read = registry_default_value(key).expect("value should parse back");
        assert_eq!(read, value);

        let _ = reg(&["delete", key, "/f"]).status();
    }
}
