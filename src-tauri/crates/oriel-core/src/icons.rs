//! Shell icons.
//!
//! `SHGetFileInfo` returns exactly the icon Explorer shows, including the real
//! artwork inside an `.exe` and the target app icon for a `.lnk`. No child
//! process, no `System.Drawing`, no per-pixel PowerShell loop. PNGs are cached
//! on disk keyed by path + mtime + size, so a relaunch is instant.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use base64::Engine;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP, HDC,
    HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON,
    SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

use crate::entry;
use crate::paths::wide_path;

static CACHE: LazyLock<Mutex<std::collections::HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

const MEMORY_CACHE_MAX: usize = 3000;

fn cache_dir() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let dir = PathBuf::from(base).join("Oriel").join("cache").join("icons");
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

const ICON_SIZE: i32 = 64;

fn cache_key(path: &str) -> String {
    match entry::stat(path) {
        Ok(stat) => format!("v2|{path}|{}|{}", stat.mtime_ms, stat.size),
        Err(_) => format!("v2|{path}|missing"),
    }
}

fn read_disk_cache(key: &str) -> Option<Option<String>> {
    let dir = cache_dir()?;
    let file = dir.join(format!("{:016x}.b64", fnv1a(key)));
    let data = std::fs::read(file).ok()?;
    let value = String::from_utf8(data).ok()?;
    if value.is_empty() {
        Some(None)
    } else {
        Some(Some(value))
    }
}

fn write_disk_cache(key: &str, value: Option<&str>) {
    if let Some(dir) = cache_dir() {
        let file = dir.join(format!("{:016x}.b64", fnv1a(key)));
        let _ = std::fs::write(file, value.unwrap_or(""));
    }
}

fn trim(rgba: &mut Vec<u8>, width: u32, height: u32) -> (u32, u32) {
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut any = false;

    for y in 0..height {
        for x in 0..width {
            let alpha = rgba[((y * width + x) * 4 + 3) as usize];
            if alpha > 8 {
                any = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    if !any {
        return (width, height);
    }

    let new_width = max_x - min_x + 1;
    let new_height = max_y - min_y + 1;
    if new_width == width && new_height == height {
        return (width, height);
    }

    let mut cropped = Vec::with_capacity((new_width * new_height * 4) as usize);
    for y in min_y..=max_y {
        let start = ((y * width + min_x) * 4) as usize;
        let end = start + (new_width * 4) as usize;
        cropped.extend_from_slice(&rgba[start..end]);
    }
    *rgba = cropped;
    (new_width, new_height)
}

unsafe fn bitmap_to_rgba(hbitmap: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let mut bitmap = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(hbitmap.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bitmap as *mut _ as *mut _),
    );
    if got == 0 {
        return None;
    }

    let width = bitmap.bmWidth.max(1) as u32;
    let height = bitmap.bmHeight.max(1) as u32;
    let mut header = BITMAPINFO::default();
    header.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    header.bmiHeader.biWidth = width as i32;
    header.bmiHeader.biHeight = -(height as i32);
    header.bmiHeader.biPlanes = 1;
    header.bmiHeader.biBitCount = 32;
    header.bmiHeader.biCompression = 0;

    let mut buffer = vec![0u8; (width * height * 4) as usize];
    let hdc: HDC = windows::Win32::Graphics::Gdi::GetDC(None);
    let lines = GetDIBits(
        hdc,
        hbitmap,
        0,
        height,
        Some(buffer.as_mut_ptr() as *mut _),
        &mut header,
        DIB_RGB_COLORS,
    );
    windows::Win32::Graphics::Gdi::ReleaseDC(None, hdc);
    if lines == 0 {
        return None;
    }

    let mut has_alpha = false;
    for index in (3..buffer.len()).step_by(4) {
        if buffer[index] != 0 {
            has_alpha = true;
            break;
        }
    }
    if !has_alpha {
        for index in (3..buffer.len()).step_by(4) {
            buffer[index] = 255;
        }
    }

    // GetDIBits hands back BGRA; the PNG encoder wants RGBA.
    for pixel in buffer.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    let (out_width, out_height) = trim(&mut buffer, width, height);
    Some((out_width, out_height, buffer))
}

/// Preferred path: the shell renders the icon at the size we ask for, with an
/// alpha channel, which is also what Explorer draws.
unsafe fn extract_with_factory(path: &str) -> Option<(u32, u32, Vec<u8>)> {
    let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path), None).ok()?;
    let hbitmap = factory
        .GetImage(
            SIZE {
                cx: ICON_SIZE,
                cy: ICON_SIZE,
            },
            SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
        )
        .ok()?;
    if hbitmap.is_invalid() {
        return None;
    }
    let converted = bitmap_to_rgba(hbitmap);
    let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    converted
}

unsafe fn icon_to_rgba(hicon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    let mut info = ICONINFO::default();
    GetIconInfo(hicon, &mut info).ok()?;

    let mut bitmap = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(info.hbmColor.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bitmap as *mut _ as *mut _),
    );
    if got == 0 {
        let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        return None;
    }

    let width = bitmap.bmWidth.max(1) as u32;
    let height = bitmap.bmHeight.max(1) as u32;
    let mut header = BITMAPINFO::default();
    header.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    header.bmiHeader.biWidth = width as i32;
    header.bmiHeader.biHeight = -(height as i32);
    header.bmiHeader.biPlanes = 1;
    header.bmiHeader.biBitCount = 32;
    header.bmiHeader.biCompression = 0;

    let mut buffer = vec![0u8; (width * height * 4) as usize];
    let hdc: HDC = windows::Win32::Graphics::Gdi::GetDC(None);
    let lines = GetDIBits(
        hdc,
        info.hbmColor,
        0,
        height,
        Some(buffer.as_mut_ptr() as *mut _),
        &mut header,
        DIB_RGB_COLORS,
    );

    let mut has_alpha = false;
    if lines != 0 {
        for index in (3..buffer.len()).step_by(4) {
            if buffer[index] != 0 {
                has_alpha = true;
                break;
            }
        }
    }

    if lines != 0 && !has_alpha && !info.hbmMask.is_invalid() {
        // Legacy icons carry their transparency in a 1bpp mask instead.
        let mut mask_header = BITMAPINFO::default();
        mask_header.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        mask_header.bmiHeader.biWidth = width as i32;
        mask_header.bmiHeader.biHeight = -(height as i32);
        mask_header.bmiHeader.biPlanes = 1;
        mask_header.bmiHeader.biBitCount = 1;
        let stride = ((width + 31) / 32 * 4) as usize;
        let mut mask = vec![0u8; stride * height as usize];
        let mask_lines = GetDIBits(
            hdc,
            info.hbmMask,
            0,
            height,
            Some(mask.as_mut_ptr() as *mut _),
            &mut mask_header,
            DIB_RGB_COLORS,
        );
        if mask_lines != 0 {
            for y in 0..height as usize {
                for x in 0..width as usize {
                    let byte = mask[y * stride + x / 8];
                    let bit = (byte >> (7 - (x % 8))) & 1;
                    let index = (y * width as usize + x) * 4 + 3;
                    buffer[index] = if bit == 1 { 0 } else { 255 };
                }
            }
        }
    } else if lines != 0 && !has_alpha {
        for index in (3..buffer.len()).step_by(4) {
            buffer[index] = 255;
        }
    }

    windows::Win32::Graphics::Gdi::ReleaseDC(None, hdc);
    let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
    let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));

    if lines == 0 {
        return None;
    }

    // GetDIBits hands back BGRA; the PNG encoder wants RGBA.
    for pixel in buffer.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    let (out_width, out_height) = trim(&mut buffer, width, height);
    Some((out_width, out_height, buffer))
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

fn extract(path: &str) -> Option<String> {
    let converted = unsafe {
        extract_with_factory(path).or_else(|| extract_with_shfileinfo(path))
    }?;
    let (width, height, rgba) = converted;
    let png = encode_png(width, height, &rgba)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    Some(format!("data:image/png;base64,{encoded}"))
}

unsafe fn extract_with_shfileinfo(path: &str) -> Option<(u32, u32, Vec<u8>)> {
    let wide = wide_path(path);
    let mut info = SHFILEINFOW::default();
    let size = std::mem::size_of::<SHFILEINFOW>() as u32;

    let flags = SHGFI_ICON | SHGFI_LARGEICON;
    let mut result = SHGetFileInfoW(
        PCWSTR(wide.as_ptr()),
        FILE_ATTRIBUTE_NORMAL,
        Some(&mut info),
        size,
        flags,
    );

    if result == 0 {
        // The file may be gone; ask the shell for the icon of its extension.
        result = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            size,
            flags | SHGFI_USEFILEATTRIBUTES,
        );
    }

    if result == 0 || info.hIcon.is_invalid() {
        return None;
    }

    let converted = icon_to_rgba(info.hIcon);
    let _ = DestroyIcon(info.hIcon);
    converted
}

fn remember(key: String, value: Option<String>) {
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= MEMORY_CACHE_MAX {
            cache.clear();
        }
        cache.insert(key, value);
    }
}

/// Icons for up to 120 paths, as data URLs. Missing entries stay `None`.
pub fn icons(paths: &[String]) -> BTreeMap<String, Option<String>> {
    let mut out = BTreeMap::new();

    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let owned = init.is_ok();

        for path in paths.iter().take(120) {
            let key = cache_key(path);

            if let Ok(cache) = CACHE.lock() {
                if let Some(value) = cache.get(&key) {
                    out.insert(path.clone(), value.clone());
                    continue;
                }
            }

            if let Some(cached) = read_disk_cache(&key) {
                remember(key.clone(), cached.clone());
                out.insert(path.clone(), cached);
                continue;
            }

            let value = extract(path);
            write_disk_cache(&key, value.as_deref());
            remember(key, value.clone());
            out.insert(path.clone(), value);
        }

        if owned {
            CoUninitialize();
        }
    }

    out
}

/// Clears the on-disk and in-memory cache, used by "refresh icons" in settings.
pub fn clear_cache() {
    if let Ok(mut cache) = CACHE.lock() {
        cache.clear();
    }
    if let Some(dir) = cache_dir() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
