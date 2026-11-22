//! Recycle bin listing and restore, read straight from the `$I` / `$R` pairs.
//!
//! Version 2 sidecars (Windows 10+) store the original path length in UTF-16
//! characters; older ones simply run to the end of the file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{CoreError, Result};
use crate::paths::file_name_of;
use crate::{drives, entry};

const FILETIME_EPOCH_OFFSET: i128 = 116_444_736_000_000_000;
const RECYCLE_DIRECTORY: &str = "$Recycle.Bin";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleItem {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub size: u64,
    pub deleted_at: i64,
    pub kind: &'static str,
    pub drive: String,
    #[serde(skip)]
    meta_path: String,
    #[serde(skip)]
    data_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleList {
    pub items: Vec<RecycleItem>,
    pub total: u64,
    pub skipped_drives: Vec<String>,
}

fn parse_sidecar(buffer: &[u8]) -> Option<(u64, i64, String)> {
    if buffer.len() < 28 {
        return None;
    }
    let version = u64::from_le_bytes(buffer[0..8].try_into().ok()?);
    let size = i64::from_le_bytes(buffer[8..16].try_into().ok()?).max(0) as u64;
    let filetime = i64::from_le_bytes(buffer[16..24].try_into().ok()?) as i128;
    let deleted_at = if filetime > FILETIME_EPOCH_OFFSET {
        ((filetime - FILETIME_EPOCH_OFFSET) / 10_000) as i64
    } else {
        0
    };

    let (name_offset, name_bytes) = if version >= 2 {
        let chars = u32::from_le_bytes(buffer[24..28].try_into().ok()?) as usize;
        (28usize, chars * 2)
    } else {
        (24usize, buffer.len().saturating_sub(24))
    };

    let (offset, length) = if name_bytes == 0 || name_offset + name_bytes > buffer.len() {
        (if version >= 2 { 28 } else { 24 }, buffer.len().saturating_sub(if version >= 2 { 28 } else { 24 }))
    } else {
        (name_offset, name_bytes)
    };

    let units: Vec<u16> = buffer[offset..offset + length]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let original = String::from_utf16_lossy(&units);
    let original = original.trim_end_matches('\0').to_string();
    if original.trim().is_empty() {
        return None;
    }
    Some((size, deleted_at, original))
}

fn read_item(meta_path: &str, drive: &str) -> Option<RecycleItem> {
    let buffer = fs::read(meta_path).ok()?;
    let (recorded_size, deleted_at, original_path) = parse_sidecar(&buffer)?;

    let base = file_name_of(meta_path);
    if !base.starts_with("$I") {
        return None;
    }
    let parent = Path::new(meta_path).parent()?;
    let data_path: PathBuf = parent.join(format!("$R{}", &base[2..]));
    let data = data_path.to_str()?.to_string();

    let stat = entry::stat(&data).ok()?;
    let size = if stat.kind == "directory" {
        recorded_size
    } else {
        stat.size
    };
    let name = file_name_of(&original_path);
    Some(RecycleItem {
        id: meta_path.to_string(),
        name: if name.is_empty() {
            original_path.clone()
        } else {
            name
        },
        original_path,
        size,
        deleted_at,
        kind: stat.kind,
        drive: drive.to_string(),
        meta_path: meta_path.to_string(),
        data_path: data,
    })
}

pub fn list() -> RecycleList {
    let mut items: Vec<RecycleItem> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for drive in drives::list(false) {
        if drive.kind == "network" {
            continue;
        }
        let bin = format!("{}{}", drive.path, RECYCLE_DIRECTORY);
        let sids = match entry::enumerate(&bin) {
            Ok(sids) => sids,
            Err(_) => continue,
        };
        let mut readable = false;
        for sid in sids {
            if !sid.is_dir() || sid.name == "." || sid.name == ".." {
                continue;
            }
            let sid_path = format!("{}\\{}", bin, sid.name);
            let metas = match entry::enumerate(&sid_path) {
                Ok(metas) => metas,
                Err(_) => continue,
            };
            readable = true;
            for meta in metas {
                if !meta.name.starts_with("$I") {
                    continue;
                }
                let path = format!("{}\\{}", sid_path, meta.name);
                if let Some(item) = read_item(&path, &drive.path) {
                    items.push(item);
                }
            }
        }
        if !readable {
            skipped.push(drive.path);
        }
    }

    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    let total = items.len() as u64;
    RecycleList {
        items,
        total,
        skipped_drives: skipped,
    }
}

fn find(id: &str) -> Result<RecycleItem> {
    let drive = crate::paths::root_of(id);
    read_item(id, &drive).ok_or_else(|| CoreError::not_found("回收站项目已不存在"))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub id: String,
    pub reason: String,
}

pub fn restore(ids: &[String]) -> (Vec<String>, Vec<Skipped>) {
    let mut restored = Vec::new();
    let mut skipped = Vec::new();
    for id in ids {
        let item = match find(id) {
            Ok(item) => item,
            Err(error) => {
                skipped.push(Skipped {
                    id: id.clone(),
                    reason: error.message,
                });
                continue;
            }
        };
        if entry::exists(&item.original_path) {
            skipped.push(Skipped {
                id: id.clone(),
                reason: "原位置已经有同名项目".to_string(),
            });
            continue;
        }
        if let Some(parent) = crate::paths::parent_of(&item.original_path) {
            if fs::create_dir_all(&parent).is_err() {
                skipped.push(Skipped {
                    id: id.clone(),
                    reason: "无法创建目标文件夹".to_string(),
                });
                continue;
            }
        }
        match fs::rename(&item.data_path, &item.original_path) {
            Ok(()) => {
                let _ = fs::remove_file(&item.meta_path);
                restored.push(item.original_path);
            }
            Err(_) => {
                // Cross-volume restore: copy then delete.
                match crate::fsops::copy_tree(&item.data_path, &item.original_path, &crate::fsops::Free, &mut |_| {}) {
                    Ok(()) => {
                        let _ = crate::fsops::remove_permanent(&item.data_path);
                        let _ = fs::remove_file(&item.meta_path);
                        restored.push(item.original_path);
                    }
                    Err(error) => skipped.push(Skipped {
                        id: id.clone(),
                        reason: error.message,
                    }),
                }
            }
        }
    }
    (restored, skipped)
}

pub fn purge(ids: &[String]) -> (u32, Vec<Skipped>) {
    let mut purged = 0u32;
    let mut skipped = Vec::new();
    for id in ids {
        let item = match find(id) {
            Ok(item) => item,
            Err(error) => {
                skipped.push(Skipped {
                    id: id.clone(),
                    reason: error.message,
                });
                continue;
            }
        };
        if let Err(error) = crate::fsops::remove_permanent(&item.data_path) {
            skipped.push(Skipped {
                id: id.clone(),
                reason: error.message,
            });
            continue;
        }
        let _ = fs::remove_file(&item.meta_path);
        purged += 1;
    }
    (purged, skipped)
}

pub fn empty() -> (u32, u32) {
    let list = list();
    let ids: Vec<String> = list.items.into_iter().map(|item| item.id).collect();
    let (purged, skipped) = purge(&ids);
    (purged, skipped.len() as u32)
}
