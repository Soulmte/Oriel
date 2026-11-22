use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
};

use crate::paths::wide_path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub path: String,
    pub name: String,
    pub label: String,
    pub total: u64,
    pub free: u64,
    pub used: u64,
    pub kind: &'static str,
}

const CACHE_TTL: Duration = Duration::from_secs(30);

static CACHE: Mutex<Option<(Instant, Vec<Drive>)>> = Mutex::new(None);

fn drive_kind(root: &str) -> &'static str {
    let wide = wide_path(root);
    // GetDriveTypeW codes: 2 removable, 3 fixed, 4 network (DRIVE_* live in
    // the WindowsProgramming module, which is not worth an extra feature).
    let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
    match kind {
        3 => "fixed",
        2 => "removable",
        4 => "network",
        _ => "unknown",
    }
}

fn drive_label(root: &str, name: &str) -> String {
    let wide = wide_path(root);
    let mut buffer = [0u16; 256];
    let result = unsafe {
        GetVolumeInformationW(
            PCWSTR(wide.as_ptr()),
            Some(&mut buffer),
            None,
            None,
            None,
            None,
        )
    };
    if result.is_ok() {
        let length = buffer.iter().position(|value| *value == 0).unwrap_or(0);
        if length > 0 {
            return String::from_utf16_lossy(&buffer[..length]);
        }
    }
    if name.to_ascii_uppercase().starts_with('C') {
        "Windows".to_string()
    } else {
        "本地磁盘".to_string()
    }
}

fn drive_space(root: &str) -> (u64, u64) {
    let wide = wide_path(root);
    let mut free_to_caller = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free_to_caller),
            Some(&mut total),
            Some(&mut free),
        )
    };
    if result.is_ok() {
        (total, free)
    } else {
        (0, 0)
    }
}

pub fn list(force: bool) -> Vec<Drive> {
    if !force {
        if let Ok(guard) = CACHE.lock() {
            if let Some((at, drives)) = guard.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return drives.clone();
                }
            }
        }
    }

    let mask = unsafe { GetLogicalDrives() };
    let mut drives = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let root = format!("{letter}:\\");
        let name = format!("{letter}:");
        let (total, free) = drive_space(&root);
        let label = drive_label(&root, &name);
        let kind = drive_kind(&root);
        drives.push(Drive {
            path: root,
            label,
            name,
            total,
            free,
            used: total.saturating_sub(free),
            kind,
        });
    }
    drives.sort_by(|a, b| a.path.cmp(&b.path));

    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((Instant::now(), drives.clone()));
    }
    drives
}

/// Longest matching drive prefix, used to widen a search to its volume.
pub fn drive_for_path(target: &str) -> Option<String> {
    list(false)
        .into_iter()
        .filter(|drive| {
            target
                .to_ascii_lowercase()
                .starts_with(&drive.path.to_ascii_lowercase())
        })
        .max_by_key(|drive| drive.path.len())
        .map(|drive| drive.path)
}
