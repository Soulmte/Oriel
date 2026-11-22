//! Directory enumeration and entry metadata.
//!
//! One `FindFirstFileEx` call returns the name, attributes, size and both
//! timestamps of every child, so listing a folder costs one syscall per
//! directory instead of one per entry. That single change is what makes the
//! search walker fast as well.

use std::cmp::Ordering;

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{FILETIME, HANDLE};
use windows::Win32::Storage::FileSystem::{
    FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
    GetFileAttributesExW, GetFileExInfoStandard, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN,
    FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SYSTEM,
    FIND_FIRST_EX_LARGE_FETCH, WIN32_FILE_ATTRIBUTE_DATA, WIN32_FIND_DATAW,
};

use crate::error::{CoreError, Result};
use crate::paths::{extension_of, join, wide_path};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime_ms: i64,
    pub birthtime_ms: i64,
    pub ext: String,
    pub hidden: bool,
    pub readonly: bool,
    pub is_link: bool,
}

const MARKER: u64 = 11644473600000;

fn filetime_to_ms(time: &FILETIME) -> i64 {
    let ticks = ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;
    if ticks == 0 {
        return 0;
    }
    (ticks / 10_000) as i64 - MARKER as i64
}

fn file_size(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

/// Name-based hidden rules. Windows already reports the attribute, but several
/// well-known system entries rely on the name so keep both signals.
const SYSTEM_NAMES: [&str; 12] = [
    "$recycle.bin",
    "$winreagent",
    "system volume information",
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "config.msi",
    "bootmgr",
    "bootnxt",
    "desktop.ini",
    "thumbs.db",
    "dumpstack.log",
];

pub fn is_hidden_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || lower.starts_with("ntuser.dat")
        || lower.starts_with("$windows.")
        || SYSTEM_NAMES.contains(&lower.as_str())
}

fn is_dir(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0
}

fn is_hidden(attributes: u32, name: &str) -> bool {
    attributes & (FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0) != 0 || is_hidden_name(name)
}

fn name_from_buffer(buffer: &[u16; 260]) -> String {
    let length = buffer.iter().position(|value| *value == 0).unwrap_or(260);
    String::from_utf16_lossy(&buffer[..length])
}

/// Raw enumeration used by both the listing route and the search walker.
pub struct RawEntry {
    pub name: String,
    pub attributes: u32,
    pub size: u64,
    pub mtime_ms: i64,
    pub birthtime_ms: i64,
}

impl RawEntry {
    pub fn is_dir(&self) -> bool {
        is_dir(self.attributes)
    }

    pub fn is_link(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
    }

    pub fn is_hidden(&self) -> bool {
        is_hidden(self.attributes, &self.name)
    }

    pub fn to_entry(&self, directory: &str) -> Entry {
        let directory_flag = self.is_dir();
        let path = join(directory, &self.name);
        Entry {
            name: self.name.clone(),
            path,
            kind: if directory_flag { "directory" } else { "file" },
            size: if directory_flag { 0 } else { self.size },
            mtime_ms: self.mtime_ms,
            birthtime_ms: if self.birthtime_ms == 0 {
                self.mtime_ms
            } else {
                self.birthtime_ms
            },
            ext: if directory_flag {
                String::new()
            } else {
                extension_of(&self.name)
            },
            hidden: self.is_hidden(),
            readonly: self.attributes & FILE_ATTRIBUTE_READONLY.0 != 0,
            is_link: self.is_link(),
        }
    }
}

/// Lists one directory. Errors carry the same codes the Node service used.
pub fn enumerate(directory: &str) -> Result<Vec<RawEntry>> {
    let pattern = join(directory, "*");
    let wide = wide_path(&pattern);
    let mut data = WIN32_FIND_DATAW::default();
    let handle: HANDLE = match unsafe {
        FindFirstFileExW(
            PCWSTR(wide.as_ptr()),
            FindExInfoBasic,
            &mut data as *mut _ as *mut _,
            FindExSearchNameMatch,
            None,
            FIND_FIRST_EX_LARGE_FETCH,
        )
    } {
        Ok(handle) => handle,
        // ERROR_FILE_NOT_FOUND means the folder exists but holds no entries.
        Err(error) if (error.code().0 as u32 & 0xFFFF) == 2 => return Ok(Vec::new()),
        Err(error) => return Err(map_find_error(error, directory)),
    };

    let mut entries = Vec::with_capacity(64);
    loop {
        let name = name_from_buffer(&data.cFileName);
        if !name.is_empty() && name != "." && name != ".." {
            entries.push(RawEntry {
                name,
                attributes: data.dwFileAttributes,
                size: file_size(data.nFileSizeHigh, data.nFileSizeLow),
                mtime_ms: filetime_to_ms(&data.ftLastWriteTime),
                birthtime_ms: filetime_to_ms(&data.ftCreationTime),
            });
        }
        if unsafe { FindNextFileW(handle, &mut data) }.is_err() {
            break;
        }
    }
    let _ = unsafe { FindClose(handle) };
    Ok(entries)
}

fn map_find_error(error: windows::core::Error, directory: &str) -> CoreError {
    let code = error.code().0 as u32;
    match code & 0xFFFF {
        2 | 3 => CoreError::not_found(format!("找不到“{directory}”")),
        5 => CoreError::new(403, "PERMISSION_DENIED", format!("没有权限访问“{directory}”")),
        15 => CoreError::new(403, "PERMISSION_DENIED", format!("“{directory}”不可用")),
        _ => CoreError::internal(error.message()),
    }
}

pub fn read_directory(directory: &str, show_hidden: bool) -> Result<Vec<Entry>> {
    let raw = enumerate(directory)?;
    let mut entries: Vec<Entry> = raw
        .iter()
        .filter(|entry| show_hidden || !entry.is_hidden())
        .map(|entry| entry.to_entry(directory))
        .collect();
    entries.sort_by(compare_entries);
    Ok(entries)
}

pub fn compare_entries(a: &Entry, b: &Entry) -> Ordering {
    if a.kind != b.kind {
        return if a.kind == "directory" {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    a.name
        .to_lowercase()
        .cmp(&b.name.to_lowercase())
        .then_with(|| a.name.cmp(&b.name))
}

pub fn stat(target: &str) -> Result<Entry> {
    let wide = wide_path(target);
    let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
    unsafe {
        GetFileAttributesExW(
            PCWSTR(wide.as_ptr()),
            GetFileExInfoStandard,
            &mut data as *mut _ as *mut _,
        )
    }
    .map_err(|error| {
        let os = error.code().0 as u32 & 0xFFFF;
        match os {
            2 | 3 => CoreError::not_found(format!("找不到“{target}”")),
            5 => CoreError::new(403, "PERMISSION_DENIED", format!("没有权限访问“{target}”")),
            _ => CoreError::internal(error.message()),
        }
    })?;

    let directory = is_dir(data.dwFileAttributes);
    let name = crate::paths::file_name_of(target);
    Ok(Entry {
        name: name.clone(),
        path: target.to_string(),
        kind: if directory { "directory" } else { "file" },
        size: if directory {
            0
        } else {
            file_size(data.nFileSizeHigh, data.nFileSizeLow)
        },
        mtime_ms: filetime_to_ms(&data.ftLastWriteTime),
        birthtime_ms: {
            let created = filetime_to_ms(&data.ftCreationTime);
            if created == 0 {
                filetime_to_ms(&data.ftLastWriteTime)
            } else {
                created
            }
        },
        ext: if directory {
            String::new()
        } else {
            extension_of(&name)
        },
        hidden: is_hidden(data.dwFileAttributes, &name),
        readonly: data.dwFileAttributes & FILE_ATTRIBUTE_READONLY.0 != 0,
        is_link: data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0,
    })
}

pub fn exists(target: &str) -> bool {
    stat(target).is_ok()
}

pub fn is_directory(target: &str) -> bool {
    stat(target)
        .map(|entry| entry.kind == "directory")
        .unwrap_or(false)
}

/// Stats only the named children of a folder; the watcher patches a listing
/// with a dozen stats instead of re-reading the whole folder.
pub fn read_entries_by_name(directory: &str, names: &[String]) -> Vec<Entry> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for name in names {
        if name.is_empty() || name.contains('\\') || name.contains('/') {
            continue;
        }
        if !seen.insert(name.clone()) {
            continue;
        }
        if out.len() >= 400 {
            break;
        }
        let target = join(directory, name);
        if let Ok(entry) = stat(&target) {
            out.push(entry);
        }
    }
    out
}

/// Lists a directory returning `(path, parent, entries)` for the list route.
pub fn list(directory: &str, show_hidden: bool) -> Result<(String, Option<String>, Vec<Entry>)> {
    let entry = stat(directory)?;
    if entry.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "该路径不是文件夹"));
    }
    let entries = read_directory(directory, show_hidden)?;
    Ok((
        directory.to_string(),
        crate::paths::parent_of(directory),
        entries,
    ))
}
