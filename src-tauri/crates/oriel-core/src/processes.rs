use std::ffi::c_void;

use serde::Serialize;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};

use crate::error::Result;

/// System images that must never be ended from the app.
const PROTECTED: [&str; 10] = [
    "system",
    "registry",
    "smss",
    "csrss",
    "wininit",
    "winlogon",
    "services",
    "lsass",
    "memory compression",
    "fontdrvhost",
];

/// `PEB.ProcessParameters` and `RTL_USER_PROCESS_PARAMETERS.CommandLine`
/// offsets. These are the documented-in-practice layouts every task manager
/// uses; nothing here is injected into the target process.
#[cfg(target_pointer_width = "64")]
const PEB_PROCESS_PARAMETERS: usize = 0x20;
#[cfg(target_pointer_width = "64")]
const PROCESS_PARAMETERS_COMMAND_LINE: usize = 0x70;
#[cfg(target_pointer_width = "32")]
const PEB_PROCESS_PARAMETERS: usize = 0x10;
#[cfg(target_pointer_width = "32")]
const PROCESS_PARAMETERS_COMMAND_LINE: usize = 0x40;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub path: Option<String>,
    /// Working set in bytes.
    pub memory: u64,
    pub threads: u32,
    /// Kernel + user time, so the UI can derive CPU% from two samples.
    pub cpu_ms: u64,
    pub started_ms: i64,
    pub cmdline: Option<String>,
    pub protected: bool,
    pub oriel: bool,
}

/// Partial read of one process; keeps the handle open for every query instead
/// of opening it three times.
#[derive(Default)]
struct Details {
    path: Option<String>,
    memory: u64,
    cpu_ms: u64,
    started_ms: i64,
    cmdline: Option<String>,
}

#[repr(C)]
#[derive(Default)]
struct BasicInformation {
    exit_status: i32,
    peb_base_address: *mut c_void,
    affinity_mask: usize,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RemoteUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

fn filetime_ticks(time: &FILETIME) -> u64 {
    ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
}

fn filetime_ms(time: &FILETIME) -> i64 {
    let ticks = filetime_ticks(time);
    if ticks == 0 {
        return 0;
    }
    (ticks / 10_000) as i64 - 11_644_473_600_000
}

fn wide_name(buffer: &[u16; 260]) -> String {
    let length = buffer.iter().position(|value| *value == 0).unwrap_or(0);
    String::from_utf16_lossy(&buffer[..length])
}

fn open_process(pid: u32, full: bool) -> Option<HANDLE> {
    if pid == 0 {
        return None;
    }
    let access = if full {
        // `GetProcessMemoryInfo` and `GetProcessTimes` need more than limited
        // query rights; requesting them together keeps one handle for all.
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_QUERY_LIMITED_INFORMATION
    } else {
        PROCESS_QUERY_LIMITED_INFORMATION
    };
    unsafe { OpenProcess(access, false, pid) }.ok()
}

fn image_path(handle: HANDLE) -> Option<String> {
    let mut buffer = [0u16; 1024];
    let mut length = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    result.ok()?;
    if length == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..length as usize]))
}

fn read_remote<T: Copy>(handle: HANDLE, address: usize) -> Option<T> {
    if address == 0 {
        return None;
    }
    let mut value = std::mem::MaybeUninit::<T>::uninit();
    let mut read = 0usize;
    unsafe {
        ReadProcessMemory(
            handle,
            address as *const c_void,
            value.as_mut_ptr() as *mut c_void,
            std::mem::size_of::<T>(),
            Some(&mut read),
        )
    }
    .ok()?;
    if read != std::mem::size_of::<T>() {
        return None;
    }
    Some(unsafe { value.assume_init() })
}

/// Best-effort command line. Needs `PROCESS_VM_READ`, so protected and
/// elevated processes simply come back empty instead of failing the listing.
fn command_line(handle: HANDLE) -> Option<String> {
    let mut info = BasicInformation::default();
    let mut returned = 0u32;
    let status = unsafe {
        NtQueryInformationProcess(
            handle,
            ProcessBasicInformation,
            &mut info as *mut BasicInformation as *mut c_void,
            std::mem::size_of::<BasicInformation>() as u32,
            &mut returned,
        )
    };
    if status.0 < 0 {
        return None;
    }

    let parameters: usize =
        read_remote(handle, (info.peb_base_address as usize).checked_add(PEB_PROCESS_PARAMETERS)?)?;
    let text: RemoteUnicodeString = read_remote(
        handle,
        parameters.checked_add(PROCESS_PARAMETERS_COMMAND_LINE)?,
    )?;

    let bytes = text.length as usize;
    if bytes == 0 || bytes > 0x7FFF || text.buffer.is_null() {
        return None;
    }

    let mut buffer = vec![0u16; bytes / 2];
    let mut read = 0usize;
    unsafe {
        ReadProcessMemory(
            handle,
            text.buffer as *const c_void,
            buffer.as_mut_ptr() as *mut c_void,
            bytes,
            Some(&mut read),
        )
    }
    .ok()?;
    if read < bytes {
        return None;
    }

    let value = String::from_utf16_lossy(&buffer);
    let value = value.trim_end_matches('\0').trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn details(pid: u32) -> Details {
    let mut out = Details::default();
    let (handle, full) = match open_process(pid, true) {
        Some(handle) => (handle, true),
        None => match open_process(pid, false) {
            Some(handle) => (handle, false),
            None => return out,
        },
    };

    out.path = image_path(handle);

    if full {
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        if unsafe {
            GetProcessMemoryInfo(
                handle,
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
        }
        .is_ok()
        {
            out.memory = counters.WorkingSetSize as u64;
        }

        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            .is_ok()
        {
            out.started_ms = filetime_ms(&created);
            out.cpu_ms = (filetime_ticks(&kernel) + filetime_ticks(&user)) / 10_000;
        }

        out.cmdline = command_line(handle);
    }

    let _ = unsafe { CloseHandle(handle) };
    out
}

fn snapshot_name(pid: u32) -> Option<String> {
    let snapshot: HANDLE = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut name = None;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while ok {
        if entry.th32ProcessID == pid {
            name = Some(wide_name(&entry.szExeFile));
            break;
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snapshot) };
    name.filter(|value| !value.is_empty())
}

fn executable_name(path: Option<&str>, pid: u32) -> String {
    if let Some(path) = path {
        if let Some(name) = path.rsplit(['\\', '/']).next() {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    snapshot_name(pid).unwrap_or_default()
}

/// Whether the app refuses to end this image.
pub fn is_protected(name: &str) -> bool {
    let lower = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".EXE"))
        .unwrap_or(name)
        .to_ascii_lowercase();
    PROTECTED.contains(&lower.as_str())
}

/// Image name and full path for one pid, without the per-process counters.
pub fn describe(pid: u32) -> (String, Option<String>) {
    let details = details(pid);
    let name = executable_name(details.path.as_deref(), pid);
    (name, details.path)
}

/// Every running process, with the numbers a process viewer needs.
pub fn list(service_pid: u32) -> Vec<ProcessEntry> {
    let mut out = Vec::new();
    let snapshot: HANDLE = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(handle) => handle,
        Err(_) => return out,
    };

    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while ok {
        let name = wide_name(&entry.szExeFile);
        let pid = entry.th32ProcessID;
        if pid > 0 && !name.is_empty() {
            let details = details(pid);
            out.push(ProcessEntry {
                pid,
                ppid: entry.th32ParentProcessID,
                cmdline: details.cmdline,
                protected: pid == 4 || is_protected(&name),
                path: details.path,
                memory: details.memory,
                threads: entry.cntThreads,
                cpu_ms: details.cpu_ms,
                started_ms: details.started_ms,
                name,
                oriel: pid == service_pid,
            });
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snapshot) };

    out.sort_by(|a, b| {
        b.memory
            .cmp(&a.memory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.pid.cmp(&b.pid))
    });
    out
}

/// Ends a process tree, sharing the guard rails with the port manager.
pub fn kill(pid: u32, service_pid: u32) -> Result<()> {
    crate::ports::kill(pid, service_pid)
}
