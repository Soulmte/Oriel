//! Thin wrapper over the Windows shell APIs.
//!
//! The REST service can copy and delete files, but the OS is the only place that
//! knows how to show the real "属性" dialog (security, permissions, previous
//! versions) or how to hand a delete to the shell's own operation queue with its
//! undo record. Both live here, behind Tauri commands.

use std::thread;

use windows::core::{Error as WinError, HSTRING, PCSTR, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Shell::{
    FileOperation, IContextMenu, IFileOperation, IShellItem, SHCreateItemFromParsingName,
    ShellExecuteExW, BHID_SFUIObject, CMF_NORMAL, CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX,
    FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, SEE_MASK_INVOKEIDLIST,
    SHELLEXECUTEINFOW,
};
/// `CMIC_MASK_UNICODE`: not exported by the windows crate, the value is stable.
const CMIC_MASK_UNICODE: u32 = 0x0000_4000;

use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetCursorPos, GetForegroundWindow, GetMenuItemCount,
    GetMenuItemInfoW, SetForegroundWindow, TrackPopupMenuEx, MENUITEMINFOW, MF_OWNERDRAW,
    MF_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STRING, MIIM_SUBMENU, SW_SHOWNORMAL, TPM_RETURNCMD,
    TPM_RIGHTBUTTON,
};

fn message(error: &WinError) -> String {
    error.message()
}

/// Runs `job` on a fresh COM apartment so the shell types are always usable.
fn with_com<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let handle = thread::spawn(move || unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let owned = init.is_ok();
        let result = job();
        if owned {
            CoUninitialize();
        }
        result
    });

    match handle.join() {
        Ok(result) => result,
        Err(_) => Err("系统调用线程异常".to_string()),
    }
}

fn item_from_path(path: &str) -> Result<IShellItem, String> {
    unsafe {
        SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(path), None)
            .map_err(|error| format!("{}: {}", message(&error), path))
    }
}

/// Opens the standard Windows properties dialog (security, details, versions).
#[tauri::command]
pub async fn open_properties(path: String) -> Result<(), String> {
    with_com(move || unsafe {
        let verb = HSTRING::from("properties");
        let file = HSTRING::from(path.as_str());

        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_INVOKEIDLIST,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            nShow: 1, // SW_SHOWNORMAL
            ..Default::default()
        };

        ShellExecuteExW(&mut info).map_err(|error| message(&error))
    })
}

/// Deletes through `IFileOperation`, which is what puts entries in the real
/// recycle bin (with an undo record) instead of our own best-effort copy.
#[tauri::command]
pub async fn shell_delete(paths: Vec<String>, permanent: bool) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    with_com(move || unsafe {
        let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
            .map_err(|error| message(&error))?;

        let mut flags = FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
        if !permanent {
            flags |= FOF_ALLOWUNDO;
        }
        operation
            .SetOperationFlags(flags)
            .map_err(|error| message(&error))?;

        for path in &paths {
            let item = item_from_path(path)?;
            operation
                .DeleteItem(&item, None)
                .map_err(|error| format!("{}: {}", message(&error), path))?;
        }

        operation
            .PerformOperations()
            .map_err(|error| message(&error))?;

        let aborted = operation
            .GetAnyOperationsAborted()
            .map_err(|error| message(&error))?;
        if aborted.as_bool() {
            return Err("操作被系统取消".to_string());
        }
        Ok(())
    })
}

/// One command the shell offers for a file (7-Zip, Send to, Defender scan…).
#[derive(serde::Serialize)]
pub struct ShellVerb {
    /// Command id, valid for a freshly built menu of the same path.
    pub id: u32,
    pub label: String,
    /// True for entries that open a nested menu.
    pub submenu: bool,
    /// Children of a submenu, so the app can render the flyout itself.
    pub children: Vec<ShellVerb>,
}

/// Walks a menu (recursively for submenus) and reports the invokable entries.
unsafe fn collect_verbs(menu: windows::Win32::UI::WindowsAndMessaging::HMENU, depth: u32) -> Vec<ShellVerb> {
    let mut verbs: Vec<ShellVerb> = Vec::new();
    if depth == 0 {
        return verbs;
    }

    let count = GetMenuItemCount(Some(menu));
    for index in 0..count.max(0) {
        // Pass 1: flags/id only. Asking for MIIM_STRING on an owner-draw item
        // makes Windows treat dwTypeData as the app-defined value and copy from
        // an arbitrary pointer, which corrupts the heap.
        let mut info = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE,
            ..Default::default()
        };

        if GetMenuItemInfoW(menu, index as u32, true, &mut info).is_err() {
            continue;
        }
        if info.fType.0 & MF_SEPARATOR.0 != 0 || info.fType.0 & MF_OWNERDRAW.0 != 0 {
            continue;
        }

        // Pass 2 overwrites the struct (and clears hSubMenu), so capture it now.
        let submenu_handle = info.hSubMenu;

        // Pass 2: plain items keep their text in the menu, copy it out.
        let mut buffer = [0u16; 512];
        info.fMask = MIIM_STRING;
        info.dwTypeData = windows::core::PWSTR(buffer.as_mut_ptr());
        info.cch = buffer.len() as u32;

        if GetMenuItemInfoW(menu, index as u32, true, &mut info).is_err() {
            continue;
        }

        let length = (info.cch as usize).min(buffer.len());
        let label: String = String::from_utf16_lossy(&buffer[..length])
            .replace('&', "")
            .trim()
            .to_string();
        if label.is_empty() {
            continue;
        }

        // A popup parent keeps its own label; its children become a flyout.
        let submenu = !submenu_handle.is_invalid();
        let children = if submenu {
            collect_verbs(submenu_handle, depth - 1)
        } else {
            Vec::new()
        };

        // Empty submenus are not worth a flyout.
        if submenu && children.is_empty() {
            continue;
        }

        verbs.push(ShellVerb {
            id: info.wID,
            label,
            submenu,
            children,
        });
    }

    verbs
}

unsafe fn build_shell_menu(path: &str) -> Result<(IContextMenu, windows::Win32::UI::WindowsAndMessaging::HMENU), String> {
    let item = item_from_path(path)?;
    let context: IContextMenu = item
        .BindToHandler(None, &BHID_SFUIObject)
        .map_err(|error| format!("{}: {}", message(&error), path))?;

    let menu = CreatePopupMenu().map_err(|error| message(&error))?;
    // 1..0x7fff leaves room for the shell to add its own command ids.
    context
        .QueryContextMenu(menu, 0, 1, 0x7fff, CMF_NORMAL)
        .ok()
        .map_err(|error| message(&error))?;

    Ok((context, menu))
}

/// Lists the shell verbs for a path so the app can show them in its own menu.
#[tauri::command]
pub async fn shell_verbs(path: String) -> Result<Vec<ShellVerb>, String> {
    with_com(move || unsafe {
        let (_, menu) = build_shell_menu(&path)?;
        let verbs = collect_verbs(menu, 3);
        let _ = DestroyMenu(menu);
        Ok(verbs)
    })
}

/// Runs one shell verb by rebuilding the menu and invoking its command id.
#[tauri::command]
pub async fn shell_invoke_verb(path: String, id: u32) -> Result<(), String> {
    with_com(move || unsafe {
        let (context, menu) = build_shell_menu(&path)?;

        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        let owner = GetForegroundWindow();
        let _ = SetForegroundWindow(owner);

        // QueryContextMenu started at 1, so the verb offset is id - 1.
        let offset = id.saturating_sub(1);
        let info = CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            fMask: CMIC_MASK_UNICODE,
            hwnd: owner,
            lpVerb: PCSTR(offset as usize as *const u8),
            lpVerbW: PCWSTR(offset as usize as *const u16),
            nShow: SW_SHOWNORMAL.0,
            ptInvoke: point,
            ..Default::default()
        };

        let result = context
            .InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO)
            .map_err(|error| message(&error));

        let _ = DestroyMenu(menu);
        result
    })
}

/// Shows the real Windows context menu ("显示更多选项") for one entry.
///
/// `TrackPopupMenuEx` routes the menu's messages to the owner window, so it has
/// to run on the thread that owns that window — Tauri's main thread. The call
/// blocks until the user picks an item or dismisses the menu, which is exactly
/// how the shell expects to be driven.
#[tauri::command]
pub async fn shell_context_menu(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<bool, String> {
    use tauri::Manager;

    let (sender, receiver) = std::sync::mpsc::channel();
    window
        .app_handle()
        .run_on_main_thread(move || {
            let _ = sender.send(unsafe { popup_shell_menu(&path) });
        })
        .map_err(|error| error.to_string())?;

    receiver.recv().map_err(|_| "菜单线程异常".to_string())?
}

unsafe fn popup_shell_menu(path: &str) -> Result<bool, String> {
    let item = item_from_path(path)?;
    let context: IContextMenu = item
        .BindToHandler(None, &BHID_SFUIObject)
        .map_err(|error| format!("{}: {}", message(&error), path))?;

    let menu = CreatePopupMenu().map_err(|error| message(&error))?;

    let result = (|| -> Result<bool, String> {
        // 1..0x7fff leaves room for the shell to add its own command ids.
        context
            .QueryContextMenu(menu, 0, 1, 0x7fff, CMF_NORMAL)
            .ok()
            .map_err(|error| message(&error))?;

        let mut point = POINT::default();
        GetCursorPos(&mut point).map_err(|error| message(&error))?;

        let owner = GetForegroundWindow();
        let _ = SetForegroundWindow(owner);

        let command = TrackPopupMenuEx(
            menu,
            TPM_RETURNCMD.0 | TPM_RIGHTBUTTON.0,
            point.x,
            point.y,
            owner,
            None,
        );

        let picked = command.0 as u32;
        if picked == 0 {
            return Ok(false);
        }

        // QueryContextMenu started at 1, so the verb offset is id - 1.
        let offset = (picked as u32).saturating_sub(1);
        let info = CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            fMask: CMIC_MASK_UNICODE,
            hwnd: owner,
            // MAKEINTRESOURCE: the command id lives in the pointer itself.
            lpVerb: PCSTR(offset as usize as *const u8),
            lpVerbW: PCWSTR(offset as usize as *const u16),
            nShow: SW_SHOWNORMAL.0,
            ptInvoke: point,
            ..Default::default()
        };

        context
            .InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO)
            .map_err(|error| message(&error))?;
        Ok(true)
    })();

    let _ = DestroyMenu(menu);
    result
}

/// Moves entries with the shell so cross-volume moves show the system progress.
#[tauri::command]
pub async fn shell_move(paths: Vec<String>, target: String) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    with_com(move || unsafe {
        let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)
            .map_err(|error| message(&error))?;
        operation
            .SetOperationFlags(FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT)
            .map_err(|error| message(&error))?;

        let destination = item_from_path(&target)?;
        for path in &paths {
            let item = item_from_path(path)?;
            operation
                .MoveItem(&item, &destination, None, None)
                .map_err(|error| format!("{}: {}", message(&error), path))?;
        }

        operation
            .PerformOperations()
            .map_err(|error| message(&error))?;

        let aborted = operation
            .GetAnyOperationsAborted()
            .map_err(|error| message(&error))?;
        if aborted.as_bool() {
            return Err("操作被系统取消".to_string());
        }
        Ok(())
    })
}

