//! Windows clipboard as other programs see it: a `CF_HDROP` file list plus
//! `Preferred DropEffect` for cut/copy. Native calls, no helper process — the
//! old implementation paid ~400 ms for a PowerShell round trip on every paste.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::UI::Shell::{DragQueryFileW, DROPFILES, HDROP};

use crate::error::{CoreError, Result};

const CF_HDROP: u32 = 15;

fn with_clipboard<T>(job: impl FnOnce() -> Result<T>) -> Result<T> {
    let mut last = None;
    for _ in 0..5 {
        match unsafe { OpenClipboard(None) } {
            Ok(()) => {
                let result = job();
                let _ = unsafe { CloseClipboard() };
                return result;
            }
            Err(error) => {
                last = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
    }
    Err(CoreError::bad_request(
        "CLIPBOARD_FAILED",
        format!(
            "剪贴板正被其他程序占用：{}",
            last.map(|error| error.message()).unwrap_or_default()
        ),
    ))
}

fn drop_effect_format() -> u32 {
    let name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
    unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) }
}

fn allocate(bytes: &[u8]) -> Result<HGLOBAL> {
    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len())
            .map_err(|error| CoreError::internal(error.message()))?;
        let pointer = GlobalLock(handle);
        if pointer.is_null() {
            return Err(CoreError::internal("无法锁定剪贴板内存"));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer as *mut u8, bytes.len());
        let _ = GlobalUnlock(handle);
        Ok(handle)
    }
}

/// Writes a file list. `cut` sets the drop effect so Explorer/Paste knows the
/// selection is a move.
pub fn write(paths: &[String], cut: bool) -> Result<usize> {
    if paths.is_empty() {
        return Err(CoreError::bad_request("CLIPBOARD_EMPTY", "没有可复制的项目"));
    }

    let mut payload: Vec<u8> = Vec::new();
    let header_size = std::mem::size_of::<DROPFILES>();
    payload.resize(header_size, 0);
    {
        let files = DROPFILES {
            pFiles: header_size as u32,
            fWide: true.into(),
            ..Default::default()
        };
        unsafe {
            std::ptr::copy_nonoverlapping(
                &files as *const DROPFILES as *const u8,
                payload.as_mut_ptr(),
                header_size,
            );
        }
    }
    for path in paths {
        for unit in path.encode_utf16() {
            payload.extend_from_slice(&unit.to_le_bytes());
        }
        payload.extend_from_slice(&0u16.to_le_bytes());
    }
    payload.extend_from_slice(&0u16.to_le_bytes());

    with_clipboard(|| {
        unsafe { EmptyClipboard() }.map_err(|error| CoreError::internal(error.message()))?;

        let handle = allocate(&payload)?;
        match unsafe { SetClipboardData(CF_HDROP, Some(HANDLE(handle.0))) } {
            Ok(_) => {}
            Err(error) => {
                let _ = unsafe { GlobalFree(Some(handle)) };
                return Err(CoreError::internal(error.message()));
            }
        }

        let effect = if cut { 2i32 } else { 1i32 };
        let effect_handle = allocate(&effect.to_le_bytes())?;
        if unsafe { SetClipboardData(drop_effect_format(), Some(HANDLE(effect_handle.0))) }.is_err() {
            let _ = unsafe { GlobalFree(Some(effect_handle)) };
        }

        Ok(paths.len())
    })
}

/// Reads the file list currently on the clipboard.
pub fn read() -> Result<(Vec<String>, bool)> {
    with_clipboard(|| {
        let handle = match unsafe { GetClipboardData(CF_HDROP) } {
            Ok(handle) => handle,
            Err(_) => return Ok((Vec::new(), false)),
        };
        if handle.is_invalid() {
            return Ok((Vec::new(), false));
        }

        let drop = HDROP(handle.0);
        let count = unsafe { DragQueryFileW(drop, u32::MAX, None) };
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let length = unsafe { DragQueryFileW(drop, index, None) };
            if length == 0 {
                continue;
            }
            let mut buffer = vec![0u16; length as usize + 1];
            let written = unsafe { DragQueryFileW(drop, index, Some(&mut buffer)) };
            if written == 0 {
                continue;
            }
            paths.push(String::from_utf16_lossy(&buffer[..written as usize]));
        }

        let mut cut = false;
        if let Ok(effect) = unsafe { GetClipboardData(drop_effect_format()) } {
            if !effect.is_invalid() {
                let global = HGLOBAL(effect.0);
                let pointer = unsafe { GlobalLock(global) };
                if !pointer.is_null() {
                    let value = unsafe { std::ptr::read_unaligned(pointer as *const i32) };
                    cut = value & 2 == 2;
                    let _ = unsafe { GlobalUnlock(global) };
                }
            }
        }

        Ok((paths, cut))
    })
}
