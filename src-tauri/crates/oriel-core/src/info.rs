use std::fs::File;
use std::io::Read;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::entry;
use crate::error::{CoreError, Result};
use crate::paths::{extension_of, file_name_of};

pub const PREVIEW_BYTE_LIMIT: u64 = 512 * 1024;
const SIZE_BUDGET: Duration = Duration::from_secs(10);
const SIZE_MAX_ENTRIES: usize = 400_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub encoding: &'static str,
    pub content: Option<String>,
    pub size: u64,
    pub truncated: bool,
}

pub fn preview(target: &str) -> Result<Preview> {
    let stat = entry::stat(target)?;
    if stat.kind == "directory" {
        return Err(CoreError::bad_request("NOT_A_FILE", "不能预览文件夹"));
    }

    let mut file = File::open(target).map_err(CoreError::from)?;
    let mut buffer = Vec::with_capacity(PREVIEW_BYTE_LIMIT as usize);
    file.by_ref()
        .take(PREVIEW_BYTE_LIMIT)
        .read_to_end(&mut buffer)
        .map_err(CoreError::from)?;

    let binary = buffer.contains(&0);
    let name = file_name_of(target);
    Ok(Preview {
        path: target.to_string(),
        ext: extension_of(&name),
        name,
        encoding: if binary { "binary" } else { "utf8" },
        content: if binary {
            None
        } else {
            Some(String::from_utf8_lossy(&buffer).to_string())
        },
        size: stat.size,
        truncated: stat.size > PREVIEW_BYTE_LIMIT,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySize {
    pub path: String,
    pub size: u64,
    pub files: u64,
    pub dirs: u64,
    pub partial: bool,
}

pub fn measure_directory(target: &str) -> DirectorySize {
    let deadline = Instant::now() + SIZE_BUDGET;
    let mut size = 0u64;
    let mut files = 0u64;
    let mut dirs = 0u64;
    let mut partial = false;
    let mut scanned = 0usize;

    let mut stack = vec![target.to_string()];
    while let Some(directory) = stack.pop() {
        if Instant::now() > deadline || scanned >= SIZE_MAX_ENTRIES {
            partial = true;
            break;
        }
        let raw = match entry::enumerate(&directory) {
            Ok(raw) => raw,
            Err(_) => {
                partial = true;
                continue;
            }
        };
        scanned += raw.len();
        for item in raw {
            if item.is_link() {
                continue;
            }
            if item.is_dir() {
                dirs += 1;
                stack.push(crate::paths::join(&directory, &item.name));
            } else {
                files += 1;
                size = size.saturating_add(item.size);
            }
        }
    }

    DirectorySize {
        path: target.to_string(),
        size,
        files,
        dirs,
        partial,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime_ms: i64,
    pub birthtime_ms: i64,
    pub readonly: bool,
    pub is_link: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageInfo>,
}

pub fn file_info(target: &str) -> Result<FileInfo> {
    let stat = entry::stat(target)?;
    let image = if stat.kind == "file" {
        image_size(target, &stat.ext)
    } else {
        None
    };
    Ok(FileInfo {
        path: target.to_string(),
        kind: stat.kind,
        size: stat.size,
        mtime_ms: stat.mtime_ms,
        birthtime_ms: stat.birthtime_ms,
        readonly: stat.readonly,
        is_link: stat.is_link,
        image,
    })
}

/// Reads just enough of the header to report pixel dimensions.
fn image_size(target: &str, ext: &str) -> Option<ImageInfo> {
    if !matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp") {
        return None;
    }
    let mut file = File::open(target).ok()?;
    let mut header = [0u8; 40];
    let read = file.read(&mut header).ok()?;
    let header = &header[..read];

    if ext == "png" && header.len() >= 24 && header.starts_with(b"\x89PNG") {
        let width = u32::from_be_bytes([header[16], header[17], header[18], header[19]]);
        let height = u32::from_be_bytes([header[20], header[21], header[22], header[23]]);
        return Some(ImageInfo {
            width,
            height,
            format: Some("png".to_string()),
        });
    }

    if ext == "gif" && header.len() >= 10 && header.starts_with(b"GIF") {
        let width = u16::from_le_bytes([header[6], header[7]]) as u32;
        let height = u16::from_le_bytes([header[8], header[9]]) as u32;
        return Some(ImageInfo {
            width,
            height,
            format: Some("gif".to_string()),
        });
    }

    if (ext == "jpg" || ext == "jpeg") && header.starts_with(&[0xFF, 0xD8]) {
        return jpeg_size(target).map(|(width, height)| ImageInfo {
            width,
            height,
            format: Some("jpeg".to_string()),
        });
    }

    None
}

fn jpeg_size(target: &str) -> Option<(u32, u32)> {
    let data = std::fs::read(target).ok()?;
    let mut index = 2usize;
    while index + 9 < data.len() {
        if data[index] != 0xFF {
            index += 1;
            continue;
        }
        let marker = data[index + 1];
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            let height = u16::from_be_bytes([data[index + 5], data[index + 6]]) as u32;
            let width = u16::from_be_bytes([data[index + 7], data[index + 8]]) as u32;
            return Some((width, height));
        }
        let length = u16::from_be_bytes([data[index + 2], data[index + 3]]) as usize;
        if length < 2 {
            break;
        }
        index += 2 + length;
    }
    None
}
