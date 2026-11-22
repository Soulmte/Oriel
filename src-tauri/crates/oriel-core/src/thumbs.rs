use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use crate::entry;
use crate::error::{CoreError, Result};

const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MEMORY_CACHE_MAX: usize = 120;

static MEMORY: LazyLock<Mutex<HashMap<String, Vec<u8>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const IMAGE_EXTENSIONS: [&str; 10] = [
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "avif", "heic",
];

pub fn is_thumbnailable(ext: &str) -> bool {
    IMAGE_EXTENSIONS.contains(&ext)
}

pub fn normalize_size(value: Option<u32>) -> u32 {
    match value.unwrap_or(256) {
        0..=64 => 64,
        65..=128 => 128,
        129..=256 => 256,
        257..=512 => 512,
        _ => 1024,
    }
}

fn cache_dir() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let dir = PathBuf::from(base).join("Oriel").join("cache").join("thumbs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn fnv1a(value: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

fn key_for(target: &str, size: u32) -> Option<String> {
    let stat = entry::stat(target).ok()?;
    Some(format!("{}|{}|{}|{}", target, stat.mtime_ms, stat.size, size))
}

/// PNG thumbnail, aspect preserved, never enlarged. Transparent background for
/// images that have alpha, matching what the sharp pipeline produced.
pub fn thumbnail(target: &str, size: u32) -> Result<Vec<u8>> {
    let stat = entry::stat(target)?;
    if stat.kind == "directory" {
        return Err(CoreError::bad_request("NOT_A_FILE", "文件夹没有缩略图"));
    }
    if !is_thumbnailable(&stat.ext) {
        return Err(CoreError::bad_request("NOT_AN_IMAGE", "该文件不是图片"));
    }
    if stat.size > MAX_SOURCE_BYTES {
        return Err(CoreError::bad_request("FILE_TOO_LARGE", "图片过大，无法生成缩略图"));
    }

    let key = match key_for(target, size) {
        Some(key) => key,
        None => format!("{target}|{size}"),
    };

    if let Ok(cache) = MEMORY.lock() {
        if let Some(bytes) = cache.get(&key) {
            return Ok(bytes.clone());
        }
    }

    let disk_path = cache_dir().map(|dir| dir.join(format!("{:016x}.png", fnv1a(&key))));
    if let Some(path) = disk_path.as_ref() {
        if let Ok(bytes) = std::fs::read(path) {
            if !bytes.is_empty() {
                remember(&key, &bytes);
                return Ok(bytes);
            }
        }
    }

    let image = image::open(target)
        .map_err(|_| CoreError::bad_request("THUMBNAIL_FAILED", "无法读取该图片"))?;
    let resized = image.thumbnail(size, size);

    let mut output = Cursor::new(Vec::new());
    resized
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| CoreError::bad_request("THUMBNAIL_FAILED", "无法生成缩略图"))?;
    let bytes = output.into_inner();

    remember(&key, &bytes);
    if let Some(path) = disk_path {
        let _ = std::fs::write(path, &bytes);
    }
    Ok(bytes)
}

fn remember(key: &str, bytes: &[u8]) {
    if let Ok(mut cache) = MEMORY.lock() {
        if cache.len() >= MEMORY_CACHE_MAX {
            cache.clear();
        }
        cache.insert(key.to_string(), bytes.to_vec());
    }
}
