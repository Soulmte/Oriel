use std::collections::HashSet;

use serde::Serialize;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
use windows::Win32::System::RestartManager::{
    RmCritical, RmEndSession, RmGetList, RmRegisterResources, RmService, RmStartSession,
    CCH_RM_SESSION_KEY, RM_PROCESS_INFO,
};

use crate::error::{CoreError, Result};
use crate::processes;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockEntry {
    pub pid: u32,
    /// Image name when Windows exposes it, otherwise the Restart Manager app name.
    pub name: String,
    pub path: Option<String>,
    /// `window`, `service`, `console`, `explorer`, `critical`, `unknown`.
    pub app_type: String,
    /// Service short name for services, e.g. `wuauserv`.
    pub service: Option<String>,
    /// True when Windows can restart the app after an update.
    pub restartable: bool,
    pub protected: bool,
    pub oriel: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockList {
    pub path: String,
    pub items: Vec<LockEntry>,
}

fn trim_units(buffer: &[u16]) -> String {
    let length = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
        .trim()
        .to_string()
}

fn app_type(value: i32) -> String {
    let label = match value {
        x if x == RmService.0 => "service",
        x if x == RmCritical.0 => "critical",
        1 | 2 => "window",
        4 => "explorer",
        5 => "console",
        _ => "unknown",
    };
    label.to_string()
}

fn read_list(handle: u32, service_pid: u32) -> Result<Vec<LockEntry>> {
    let mut needed = 0u32;
    let mut count = 0u32;
    let mut reasons = 0u32;

    // First call only asks for the buffer size. `ERROR_SUCCESS` here means the
    // resource is not held by anyone, which is the common case.
    let probe = unsafe { RmGetList(handle, &mut needed, &mut count, None, &mut reasons) };
    if probe == ERROR_SUCCESS {
        return Ok(Vec::new());
    }
    if probe != ERROR_MORE_DATA || needed == 0 {
        return Err(CoreError::internal(format!(
            "占用检查失败（错误码 {}）",
            probe.0
        )));
    }

    // The process list can grow between the sizing call and the fill call; at
    // most two retries is enough for a file-lock check.
    let mut buffer = Vec::new();
    for attempt in 0..3 {
        let capacity = needed.max(1) as usize;
        buffer = std::iter::repeat_with(RM_PROCESS_INFO::default)
            .take(capacity)
            .collect();
        count = capacity as u32;
        let result = unsafe {
            RmGetList(
                handle,
                &mut needed,
                &mut count,
                Some(buffer.as_mut_ptr()),
                &mut reasons,
            )
        };
        if result == ERROR_SUCCESS {
            buffer.truncate(count as usize);
            break;
        }
        if result != ERROR_MORE_DATA || attempt == 2 {
            return Err(CoreError::internal(format!(
                "占用检查失败（错误码 {}）",
                result.0
            )));
        }
    }

    let mut seen = HashSet::new();
    let mut items = Vec::with_capacity(buffer.len());
    for info in buffer {
        let pid = info.Process.dwProcessId;
        if pid == 0 || !seen.insert(pid) {
            continue;
        }
        let (image, image_path) = processes::describe(pid);
        let app_name = trim_units(&info.strAppName);
        let service = trim_units(&info.strServiceShortName);

        let name = if !image.is_empty() {
            image
        } else if !app_name.is_empty() {
            app_name
        } else {
            format!("PID {pid}")
        };

        items.push(LockEntry {
            pid,
            protected: pid == 4 || processes::is_protected(&name),
            path: image_path,
            app_type: app_type(info.ApplicationType.0),
            service: if service.is_empty() { None } else { Some(service) },
            restartable: info.bRestartable.as_bool(),
            oriel: pid == service_pid,
            name,
        });
    }

    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(items)
}

/// Every process holding a handle on `path`, via the Windows Restart Manager.
/// Works without administrator rights and never touches the file itself.
pub fn who_locks(path: &str, service_pid: u32) -> Result<LockList> {
    let target = path.trim();
    if target.is_empty() {
        return Err(CoreError::invalid_path("路径不能为空"));
    }
    if !std::path::Path::new(target).exists() {
        return Err(CoreError::not_found("找不到这个文件或文件夹"));
    }

    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let mut handle = 0u32;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];

    let start = unsafe { RmStartSession(&mut handle, None, PWSTR(key.as_mut_ptr())) };
    if start != ERROR_SUCCESS {
        return Err(CoreError::internal(format!(
            "无法启动占用检查（错误码 {}）",
            start.0
        )));
    }

    let result = (|| {
        let file = PCWSTR(wide.as_ptr());
        let register = unsafe { RmRegisterResources(handle, Some(&[file]), None, None) };
        if register != ERROR_SUCCESS {
            return Err(CoreError::internal(format!(
                "无法读取文件占用（错误码 {}）",
                register.0
            )));
        }
        read_list(handle, service_pid)
    })();

    let _ = unsafe { RmEndSession(handle) };

    result.map(|items| LockList {
        path: target.to_string(),
        items,
    })
}
