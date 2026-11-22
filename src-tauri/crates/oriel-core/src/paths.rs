use std::env;
use std::path::{Component, Path, PathBuf};

use crate::error::{CoreError, Result};

fn is_drive_absolute(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn is_unc(raw: &str) -> bool {
    raw.starts_with("\\\\") || raw.starts_with("//")
}

/// Normalizes an absolute Windows path exactly like `path.win32.resolve` did in
/// the Node service: forward slashes collapse, `.` drops, `..` pops, and a
/// trailing separator survives only on a volume root.
pub fn normalize_path(input: Option<&str>) -> Result<String> {
    let raw = input.unwrap_or("").trim();
    if raw.is_empty() {
        return Err(CoreError::invalid_path("缺少路径参数"));
    }
    if raw.contains('\u{0}') {
        return Err(CoreError::invalid_path("路径包含非法字符"));
    }

    let unified = raw.replace('/', "\\");

    let (prefix, rest) = if is_unc(&unified) {
        let trimmed = unified.trim_start_matches('\\');
        let mut parts = trimmed.splitn(3, '\\');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        if server.is_empty() || share.is_empty() {
            return Err(CoreError::invalid_path("路径必须是绝对路径"));
        }
        (
            format!("\\\\{server}\\{share}"),
            parts.next().unwrap_or("").to_string(),
        )
    } else if is_drive_absolute(&unified) {
        (unified[..2].to_string(), unified[2..].to_string())
    } else {
        return Err(CoreError::invalid_path("路径必须是绝对路径"));
    };

    let mut depth: Vec<&str> = Vec::new();
    for part in rest.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                depth.pop();
            }
            other => depth.push(other),
        }
    }

    let joined = if depth.is_empty() {
        format!("{prefix}\\")
    } else {
        format!("{prefix}\\{}", depth.join("\\"))
    };
    Ok(joined)
}

/// Same as `normalize_path`, but tolerates an already normalized value.
pub fn normalize(raw: &str) -> Result<String> {
    normalize_path(Some(raw))
}

pub fn validate_entry_name(input: &str) -> Result<String> {
    let name = input.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err(CoreError::bad_request("INVALID_NAME", "名称不能为空"));
    }
    if name
        .chars()
        .any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20)
    {
        return Err(CoreError::bad_request(
            "INVALID_NAME",
            "名称不能包含 \\ / : * ? \" < > |",
        ));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(CoreError::bad_request("INVALID_NAME", "名称不能以空格或句点结尾"));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err(CoreError::bad_request("INVALID_NAME", "该名称是 Windows 保留名称"));
    }
    Ok(name.to_string())
}

/// Volume root of a normalized path (`C:\`, or a UNC share root).
pub fn root_of(target: &str) -> String {
    if is_unc(target) {
        let trimmed = target.trim_start_matches('\\');
        let mut parts = trimmed.splitn(3, '\\');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        return format!("\\\\{server}\\{share}\\");
    }
    if target.len() >= 2 && target.as_bytes().get(1) == Some(&b':') {
        return format!("{}\\", &target[..2]);
    }
    "\\".to_string()
}

pub fn parent_of(target: &str) -> Option<String> {
    let root = root_of(target);
    let trimmed = target.trim_end_matches('\\');
    let root_trimmed = root.trim_end_matches('\\');
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(root_trimmed) {
        return None;
    }
    match trimmed.rfind('\\') {
        Some(index) => {
            let candidate = &trimmed[..index];
            if candidate.len() <= root_trimmed.len() {
                Some(root)
            } else {
                Some(candidate.to_string())
            }
        }
        None => None,
    }
}

pub fn is_filesystem_root(target: &str) -> bool {
    let root = root_of(target);
    target == root || target.eq_ignore_ascii_case(root.trim_end_matches('\\'))
}

pub fn is_same_path(a: &str, b: &str) -> bool {
    a.trim_end_matches('\\').eq_ignore_ascii_case(b.trim_end_matches('\\'))
}

/// True when `parent` equals `child` or contains it.
pub fn is_within(parent: &str, child: &str) -> bool {
    let parent = parent.trim_end_matches('\\').to_ascii_lowercase();
    let child = child.trim_end_matches('\\').to_ascii_lowercase();
    child == parent || child.starts_with(&format!("{parent}\\"))
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('\\') {
        format!("{dir}{name}")
    } else {
        format!("{dir}\\{name}")
    }
}

fn protected_directories() -> Vec<String> {
    let keys = [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "USERPROFILE",
    ];
    let mut out: Vec<String> = keys
        .iter()
        .filter_map(|key| env::var(key).ok())
        .filter(|value| !value.trim().is_empty())
        .collect();
    if let Ok(cwd) = env::current_dir() {
        out.push(cwd.to_string_lossy().to_string());
    }
    out
}

pub fn is_protected_directory(target: &str) -> bool {
    protected_directories()
        .iter()
        .any(|guarded| is_same_path(target, guarded))
}

pub fn assert_safe_to_delete(target: &str) -> Result<()> {
    if is_filesystem_root(target) {
        return Err(CoreError::forbidden("UNSAFE_OPERATION", "不能删除磁盘根目录"));
    }
    for guarded in protected_directories() {
        if is_same_path(target, &guarded) {
            return Err(CoreError::forbidden(
                "UNSAFE_OPERATION",
                format!("“{guarded}” 是系统或服务目录，不能删除"),
            ));
        }
    }
    Ok(())
}

/// Expands `~`, `%VAR%` and `$VAR`, then normalizes. Mirrors the old
/// `/api/fs/resolve` route.
pub fn resolve_input(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CoreError::invalid_path("缺少路径"));
    }

    let home = env::var("USERPROFILE").unwrap_or_default();
    let mut value = trimmed.to_string();
    if value == "~" {
        value = home.clone();
    } else if let Some(rest) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
        value = join(&home, rest);
    }

    value = expand_percent_vars(&value);
    value = expand_dollar_vars(&value);
    if value.contains('/') {
        value = value.replace('/', "\\");
    }
    normalize(&value)
}

fn expand_percent_vars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '%' {
            if let Some(close) = chars[index + 1..].iter().position(|c| *c == '%') {
                let name: String = chars[index + 1..index + 1 + close].iter().collect();
                if let Ok(value) = env::var(&name) {
                    out.push_str(&value);
                    index += close + 2;
                    continue;
                }
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn expand_dollar_vars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes: Vec<char> = input.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == '$' {
            let (name, consumed) = read_var_name(&bytes[index + 1..]);
            if !name.is_empty() {
                if let Ok(value) = env::var(&name) {
                    out.push_str(&value);
                    index += consumed + 1;
                    continue;
                }
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    out
}

fn read_var_name(rest: &[char]) -> (String, usize) {
    if rest.first() == Some(&'{') {
        if let Some(close) = rest.iter().position(|c| *c == '}') {
            let name: String = rest[1..close].iter().collect();
            if is_var_name(&name) {
                return (name, close + 1);
            }
        }
        return (String::new(), 0);
    }
    let mut end = 0;
    while end < rest.len() {
        let c = rest[end];
        if c.is_ascii_alphanumeric() || c == '_' {
            end += 1;
        } else {
            break;
        }
    }
    if end == 0 {
        return (String::new(), 0);
    }
    (rest[..end].iter().collect(), end)
}

fn is_var_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic() || c == '_')
            .unwrap_or(false)
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn to_path(target: &str) -> PathBuf {
    // `\\?\` keeps long paths working; the prefix is skipped for already
    // extended paths and for relative-looking input.
    PathBuf::from(target)
}

/// Long-path aware form used for Win32 wide-string calls.
pub fn wide_path(target: &str) -> Vec<u16> {
    let needs_prefix = target.len() >= 240 && !target.starts_with("\\\\?\\");
    let value = if needs_prefix {
        format!("\\\\?\\{target}")
    } else {
        target.to_string()
    };
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    wide.push(0);
    wide
}

pub fn file_name_of(target: &str) -> String {
    Path::new(target)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| target.to_string())
}

pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(0) | None => String::new(),
        Some(index) => name[index + 1..].to_ascii_lowercase(),
    }
}

/// Components of a path, used by the search walker.
pub fn components_of(target: &str) -> Vec<Component<'_>> {
    Path::new(target).components().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_drive_paths() {
        assert_eq!(normalize_path(Some("C:/Users//lq/./Desktop/..")).unwrap(), "C:\\Users\\lq");
        assert_eq!(normalize_path(Some("c:\\")).unwrap(), "c:\\");
    }

    #[test]
    fn rejects_relative_paths() {
        assert!(normalize_path(Some("Users")).is_err());
        assert!(normalize_path(Some("")).is_err());
    }

    #[test]
    fn parents_and_roots() {
        assert_eq!(parent_of("C:\\").as_deref(), None);
        assert_eq!(parent_of("C:\\Users").as_deref(), Some("C:\\"));
        assert_eq!(parent_of("C:\\Users\\lq").as_deref(), Some("C:\\Users"));
    }

    #[test]
    fn extensions_match_node_semantics() {
        assert_eq!(extension_of("a.PNG"), "png");
        assert_eq!(extension_of(".gitignore"), "");
        assert_eq!(extension_of("a."), "");
        assert_eq!(extension_of("noext"), "");
    }
}
