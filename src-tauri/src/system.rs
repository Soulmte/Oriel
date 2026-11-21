//! Everything the packaged app needs from the OS itself.
//!
//! The web UI is only half of a file manager: the service that reads the disk
//! has to be running before the window is useful, the window has to survive a
//! close-to-tray, and Windows has to be told that Oriel exists as a handler.
//! This module owns that: it boots the bundled Node service, keeps its process
//! handle, exposes tray/autostart/handler toggles as commands, and cleans up on
//! exit.

use std::net::{TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

/// Holds the bundled service process so it can be killed on exit.
pub struct ServiceProcess(pub Mutex<Option<Child>>);

/// Tray icon handle, kept so the UI can hide/show it at runtime.
pub struct TrayHandle(pub Mutex<Option<TrayIcon>>);

/// Whether closing the window hides it (true) or quits (false). Owned by the
/// front end through `set_close_behavior`, read by the close handler.
pub struct CloseBehavior(pub AtomicBool);

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Oriel";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

/// The service is bundled next to the executable as `server/node.exe` +
/// `server/app/{dist,node_modules}`.
fn service_dir(app: &AppHandle) -> Option<PathBuf> {
    let root = app.path().resource_dir().ok()?;
    for candidate in [root.join("server"), root.join("resources").join("server")] {
        if candidate.join("node.exe").exists() {
            return Some(candidate);
        }
    }
    None
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

fn spawn_service(app: &AppHandle) -> Option<Child> {
    let root = match app.path().resource_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log(&format!("resource_dir failed: {error}"));
            return None;
        }
    };
    log(&format!("resource_dir = {}", root.display()));
    let dir = service_dir(app)?;
    log(&format!("service dir = {}", dir.display()));
    let dir = plain(dir);
    let entry = dir.join("app").join("dist").join("index.js");
    if !entry.exists() {
        log(&format!("entry missing: {}", entry.display()));
        return None;
    }

    // Keep the service's own log next to the app instead of a console window.
    let log_file = std::env::var("TEMP")
        .ok()
        .map(|temp| std::path::Path::new(&temp).join("oriel-server.log"))
        .and_then(|path| std::fs::File::create(path).ok());

    let mut command = Command::new(dir.join("node.exe"));
    command
        .arg(&entry)
        .current_dir(dir.join("app"))
        // The updater has no build-time env, so the repository is passed here.
        .env("ORIEL_UPDATE_REPO", "Soulmte/Oriel")
        .env("ORIEL_HOST", "127.0.0.1")
        .env("ORIEL_PORT", api_port().to_string())
        // A live pipe: when Oriel exits (even after a crash) the child sees EOF
        // and shuts itself down instead of leaking a server on port 8787.
        .stdin(Stdio::piped());
    match log_file {
        Some(file) => {
            let clone = file.try_clone().ok();
            command.stdout(file);
            if let Some(clone) = clone {
                command.stderr(clone);
            } else {
                command.stderr(Stdio::null());
            }
        }
        None => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    match command.spawn() {
        Ok(child) => {
            log(&format!("spawned pid {}", child.id()));
            Some(child)
        }
        Err(error) => {
            log(&format!("spawn failed: {error}"));
            None
        }
    }
}

/// Starts the bundled service unless something already listens on the port
/// (the dev server, or a second window that booted first).
pub fn ensure_service(app: &AppHandle) {
    let port = api_port();
    log(&format!("ensure_service port {port}"));
    if api_ready(port) {
        log("port already served");
        return;
    }

    let child = spawn_service(app);
    if let Some(state) = app.try_state::<ServiceProcess>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = child;
        }
    }

    // Wait briefly so the first paint already has a live service.
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if api_ready(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

fn stop_service(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServiceProcess>() {
        if let Ok(mut slot) = state.0.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
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
                stop_service(app);
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

#[tauri::command]
pub fn get_autostart() -> AutostartState {
    let enabled = Command::new("reg")
        .args(["query", RUN_KEY, "/v", RUN_VALUE])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    AutostartState {
        enabled,
        supported: cfg!(windows),
    }
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    let status = if enabled {
        Command::new("reg")
            .args([
                "add",
                RUN_KEY,
                "/v",
                RUN_VALUE,
                "/t",
                "REG_SZ",
                "/d",
                &current_exe_quoted(),
                "/f",
            ])
            .status()
    } else {
        Command::new("reg")
            .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
            .status()
    };

    status
        .map(|code| code.success())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_close_behavior(state: State<'_, CloseBehavior>, minimize: bool) {
    state.0.store(minimize, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_tray_visible(
    app: AppHandle,
    state: State<'_, TrayHandle>,
    visible: bool,
) -> Result<(), String> {
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
            let _ = Command::new("reg")
                .args(["add", key, "/ve", "/t", "REG_SZ", "/d", "用 Oriel 打开", "/f"])
                .status();
            let _ = Command::new("reg")
                .args([
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
            let _ = Command::new("reg")
                .args([
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
            let _ = Command::new("reg").args(["delete", key, "/f"]).status();
        }
    }

    Ok(enabled)
}

#[tauri::command]
pub fn open_default_apps() {
    #[cfg(windows)]
    {
        let _ = Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps"])
            .spawn();
    }
}

/* ----------------------------------------------------------------- setup */

pub fn shutdown(app: &AppHandle) {
    stop_service(app);
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
