use std::collections::HashMap;
use std::net::Ipv6Addr;
use std::ptr;

use serde::Serialize;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    UDP_TABLE_OWNER_PID,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::error::{CoreError, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortEntry {
    pub protocol: &'static str,
    pub address: String,
    pub port: u16,
    pub pid: u32,
    pub process: String,
    pub path: Option<String>,
    pub oriel: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortList {
    pub items: Vec<PortEntry>,
    pub platform: &'static str,
    pub note: Option<String>,
}

struct Row {
    protocol: &'static str,
    address: String,
    port: u16,
    pid: u32,
}

fn read_v4_table(bytes: &[u8]) -> Vec<(String, u16, u32)> {
    let mut out = Vec::new();
    if bytes.len() < 4 {
        return out;
    }
    let count = unsafe { ptr::read_unaligned(bytes.as_ptr() as *const u32) } as usize;
    let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    for index in 0..count {
        let offset = 4 + index * row_size;
        if offset + row_size > bytes.len() {
            break;
        }
        let row = unsafe {
            ptr::read_unaligned(bytes.as_ptr().add(offset) as *const MIB_TCPROW_OWNER_PID)
        };
        let octets = row.dwLocalAddr.to_ne_bytes();
        out.push((
            format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3]),
            u16::from_be((row.dwLocalPort & 0xFFFF) as u16),
            row.dwOwningPid,
        ));
    }
    out
}

fn read_tcp6_table(bytes: &[u8]) -> Vec<(String, u16, u32)> {
    let mut out = Vec::new();
    if bytes.len() < 4 {
        return out;
    }
    let count = unsafe { ptr::read_unaligned(bytes.as_ptr() as *const u32) } as usize;
    let row_size = std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>();
    for index in 0..count {
        let offset = 4 + index * row_size;
        if offset + row_size > bytes.len() {
            break;
        }
        let row = unsafe {
            ptr::read_unaligned(bytes.as_ptr().add(offset) as *const MIB_TCP6ROW_OWNER_PID)
        };
        out.push((
            Ipv6Addr::from(row.ucLocalAddr).to_string(),
            u16::from_be((row.dwLocalPort & 0xFFFF) as u16),
            row.dwOwningPid,
        ));
    }
    out
}

fn read_udp4_table(bytes: &[u8]) -> Vec<(String, u16, u32)> {
    let mut out = Vec::new();
    if bytes.len() < 4 {
        return out;
    }
    let count = unsafe { ptr::read_unaligned(bytes.as_ptr() as *const u32) } as usize;
    let row_size = std::mem::size_of::<MIB_UDPROW_OWNER_PID>();
    for index in 0..count {
        let offset = 4 + index * row_size;
        if offset + row_size > bytes.len() {
            break;
        }
        let row = unsafe {
            ptr::read_unaligned(bytes.as_ptr().add(offset) as *const MIB_UDPROW_OWNER_PID)
        };
        let octets = row.dwLocalAddr.to_ne_bytes();
        out.push((
            format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3]),
            u16::from_be((row.dwLocalPort & 0xFFFF) as u16),
            row.dwOwningPid,
        ));
    }
    out
}

fn read_udp6_table(bytes: &[u8]) -> Vec<(String, u16, u32)> {
    let mut out = Vec::new();
    if bytes.len() < 4 {
        return out;
    }
    let count = unsafe { ptr::read_unaligned(bytes.as_ptr() as *const u32) } as usize;
    let row_size = std::mem::size_of::<MIB_UDP6ROW_OWNER_PID>();
    for index in 0..count {
        let offset = 4 + index * row_size;
        if offset + row_size > bytes.len() {
            break;
        }
        let row = unsafe {
            ptr::read_unaligned(bytes.as_ptr().add(offset) as *const MIB_UDP6ROW_OWNER_PID)
        };
        out.push((
            Ipv6Addr::from(row.ucLocalAddr).to_string(),
            u16::from_be((row.dwLocalPort & 0xFFFF) as u16),
            row.dwOwningPid,
        ));
    }
    out
}

fn tcp_rows() -> Vec<Row> {
    let mut rows = Vec::new();
    for family in [AF_INET, AF_INET6] {
        let mut size = 0u32;
        unsafe {
            GetExtendedTcpTable(
                None,
                &mut size,
                false,
                family.0 as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            );
        }
        if size == 0 {
            continue;
        }
        let mut buffer = vec![0u8; size as usize];
        let result = unsafe {
            GetExtendedTcpTable(
                Some(buffer.as_mut_ptr() as *mut _),
                &mut size,
                false,
                family.0 as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if result != 0 {
            continue;
        }
        let parsed = if family == AF_INET {
            read_v4_table(&buffer)
        } else {
            read_tcp6_table(&buffer)
        };
        rows.extend(parsed.into_iter().map(|(address, port, pid)| Row {
            protocol: "TCP",
            address,
            port,
            pid,
        }));
    }
    rows
}

fn udp_rows() -> Vec<Row> {
    let mut rows = Vec::new();
    for family in [AF_INET, AF_INET6] {
        let mut size = 0u32;
        unsafe {
            GetExtendedUdpTable(
                None,
                &mut size,
                false,
                family.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
        }
        if size == 0 {
            continue;
        }
        let mut buffer = vec![0u8; size as usize];
        let result = unsafe {
            GetExtendedUdpTable(
                Some(buffer.as_mut_ptr() as *mut _),
                &mut size,
                false,
                family.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            )
        };
        if result != 0 {
            continue;
        }
        let parsed = if family == AF_INET {
            read_udp4_table(&buffer)
        } else {
            read_udp6_table(&buffer)
        };
        rows.extend(parsed.into_iter().map(|(address, port, pid)| Row {
            protocol: "UDP",
            address,
            port,
            pid,
        }));
    }
    rows
}

fn wide_name(buffer: &[u16; 260]) -> String {
    let length = buffer.iter().position(|value| *value == 0).unwrap_or(0);
    String::from_utf16_lossy(&buffer[..length])
}

/// pid → executable name from one Toolhelp snapshot. This works for processes
/// owned by other users, where `OpenProcess` would be denied.
fn process_names() -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let snapshot: HANDLE = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(handle) => handle,
        Err(_) => return map,
    };

    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while ok {
        let name = wide_name(&entry.szExeFile);
        let short = name
            .strip_suffix(".exe")
            .or_else(|| name.strip_suffix(".EXE"))
            .unwrap_or(&name)
            .to_string();
        if !short.is_empty() {
            map.insert(entry.th32ProcessID, short);
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snapshot) };
    map
}

fn process_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
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
    let _ = unsafe { CloseHandle(handle) };
    result.ok()?;
    if length == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..length as usize]))
}

/// Listening TCP and UDP endpoints with their owning processes. Two IP Helper
/// calls total, no PowerShell and no `netstat` parsing.
pub fn list(service_pid: u32, service_port: u16) -> PortList {
    let names = process_names();
    let mut items: Vec<PortEntry> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for row in tcp_rows().into_iter().chain(udp_rows()) {
        if row.port == 0 {
            continue;
        }
        let key = (row.protocol, row.address.clone(), row.port, row.pid);
        if !seen.insert(key) {
            continue;
        }
        let process = names.get(&row.pid).cloned().unwrap_or_default();
        let path = if process.is_empty() {
            None
        } else {
            process_path(row.pid)
        };
        items.push(PortEntry {
            protocol: row.protocol,
            address: row.address,
            port: row.port,
            pid: row.pid,
            process,
            path,
            oriel: row.pid == service_pid || row.port == service_port,
        });
    }

    items.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| a.protocol.cmp(b.protocol))
            .then_with(|| a.address.cmp(&b.address))
    });

    PortList {
        items,
        platform: "win32",
        note: None,
    }
}

const PROTECTED: [&str; 8] = [
    "system",
    "registry",
    "smss",
    "csrss",
    "wininit",
    "winlogon",
    "services",
    "lsass",
];

/// Ends a process tree. The same guard rails as the old service: never the
/// service itself, never its parent, never a critical system image.
pub fn kill(pid: u32, service_pid: u32) -> Result<()> {
    if pid == 0 || pid == 4 {
        return Err(CoreError::bad_request("CANNOT_KILL_SYSTEM", "不能结束系统进程"));
    }
    if pid == service_pid {
        return Err(CoreError::bad_request(
            "CANNOT_KILL_SERVICE",
            "这是 Oriel 的本地服务，请到设置里重启",
        ));
    }
    if let Some(name) = process_names().get(&pid) {
        if PROTECTED.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(CoreError::bad_request(
                "PROTECTED_PROCESS",
                format!("不能结束系统进程 {name}"),
            ));
        }
    }

    let mut taskkill = std::process::Command::new("taskkill");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Killing a port's process must not flash a console window.
        taskkill.creation_flags(0x0800_0000);
    }
    let output = taskkill
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|error| CoreError::bad_request("KILL_FAILED", error.to_string()))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(CoreError::bad_request(
            "KILL_FAILED",
            if detail.is_empty() {
                "结束进程失败，可能需要管理员权限".to_string()
            } else {
                format!("结束进程失败：{detail}")
            },
        ));
    }
    Ok(())
}
