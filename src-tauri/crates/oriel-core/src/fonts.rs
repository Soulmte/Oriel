use std::collections::BTreeSet;

use windows::Win32::Foundation::LPARAM;
use windows::Win32::Graphics::Gdi::{
    EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, FONTENUMPROCW, LOGFONTW, TEXTMETRICW,
};

unsafe extern "system" fn collect_family(
    logfont: *const LOGFONTW,
    _text_metric: *const TEXTMETRICW,
    _font_type: u32,
    lparam: LPARAM,
) -> i32 {
    if !logfont.is_null() {
        let font = &*logfont;
        let length = font
            .lfFaceName
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(font.lfFaceName.len());
        if length > 0 {
            let name = String::from_utf16_lossy(&font.lfFaceName[..length]);
            let family = name.trim_start_matches('@').to_string();
            if !family.is_empty() {
                let list = &mut *(lparam.0 as *mut BTreeSet<String>);
                list.insert(family);
            }
        }
    }
    1
}

/// Installed font families, deduplicated and sorted. One GDI enumeration, no
/// registry walk and no child process.
pub fn list() -> Vec<String> {
    let mut families: BTreeSet<String> = BTreeSet::new();
    unsafe {
        let hdc = GetDC(None);
        if hdc.is_invalid() {
            return Vec::new();
        }
        let mut logfont = LOGFONTW {
            lfCharSet: DEFAULT_CHARSET,
            ..Default::default()
        };
        let callback: FONTENUMPROCW = Some(collect_family);
        EnumFontFamiliesExW(
            hdc,
            &mut logfont,
            callback,
            LPARAM(&mut families as *mut _ as isize),
            0,
        );
        ReleaseDC(None, hdc);
    }
    families.into_iter().collect()
}
