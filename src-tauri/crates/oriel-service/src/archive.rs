//! Archive browsing through the 7-Zip command line.
//!
//! `7z l -slt -ba` prints a stable `Key = Value` block per entry for zip, 7z,
//! rar, tar, gz and iso alike, so one parser covers every format.

use std::path::PathBuf;
use std::process::Command;
use std::sync::{LazyLock, Mutex};

use oriel_core::entry::Entry;
use oriel_core::paths::{extension_of, file_name_of};
use oriel_core::CoreError;

const ARCHIVE_SCHEME: &str = "archive://";
const SEPARATOR: char = '|';

static SEVEN_ZIP: LazyLock<Mutex<Option<Option<PathBuf>>>> = LazyLock::new(|| Mutex::new(None));

fn find_tool() -> Option<PathBuf> {
    let candidates = [
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
        "D:\\7z\\7-Zip\\7z.exe",
    ];
    for candidate in candidates {
        if std::path::Path::new(candidate).is_file() {
            return Some(PathBuf::from(candidate));
        }
    }
    if Command::new("7z.exe").arg("i").output().is_ok() {
        return Some(PathBuf::from("7z.exe"));
    }
    if let Ok(paths) = std::env::var("PATH") {
        for dir in paths.split(';') {
            let candidate = PathBuf::from(dir).join("7z.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn tool() -> Result<PathBuf, CoreError> {
    if let Ok(cache) = SEVEN_ZIP.lock() {
        if let Some(cached) = cache.as_ref() {
            return cached.clone().ok_or_else(|| missing_tool());
        }
    }
    let found = find_tool();
    if let Ok(mut cache) = SEVEN_ZIP.lock() {
        *cache = Some(found.clone());
    }
    found.ok_or_else(missing_tool)
}

fn missing_tool() -> CoreError {
    CoreError::bad_request(
        "SEVEN_ZIP_MISSING",
        "未找到 7-Zip，请安装 7-Zip 或把 7z.exe 放到 PATH 中",
    )
}

pub fn is_archive_path(target: &str) -> bool {
    target.starts_with(ARCHIVE_SCHEME)
}

pub struct Location {
    pub archive: String,
    pub inner: String,
}

pub fn parse(target: &str) -> Result<Location, CoreError> {
    let body = target
        .strip_prefix(ARCHIVE_SCHEME)
        .ok_or_else(|| CoreError::bad_request("INVALID_ARCHIVE_PATH", "不是归档路径"))?;
    let (archive, raw_inner) = match body.find(SEPARATOR) {
        Some(index) => (&body[..index], &body[index + 1..]),
        None => (body, ""),
    };
    if archive.is_empty() || !archive.contains(':') {
        return Err(CoreError::bad_request("INVALID_ARCHIVE_PATH", "归档路径无效"));
    }
    let inner = raw_inner
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("\\");
    if inner.split('\\').any(|part| part == "..") {
        return Err(CoreError::bad_request(
            "INVALID_ARCHIVE_PATH",
            "归档内路径不能包含 ..",
        ));
    }
    Ok(Location {
        archive: archive.to_string(),
        inner,
    })
}

pub fn build(archive: &str, inner: &str) -> String {
    format!("{ARCHIVE_SCHEME}{archive}{SEPARATOR}{inner}")
}

#[derive(Clone)]
struct RawEntry {
    path: String,
    size: u64,
    is_dir: bool,
    mtime_ms: i64,
}

fn parse_slt(output: &str) -> Vec<RawEntry> {
    let mut entries = Vec::new();
    let mut path: Option<String> = None;
    let mut size = 0u64;
    let mut is_dir = false;
    let mut mtime = 0i64;

    let flush = |path: &mut Option<String>, size: &mut u64, is_dir: &mut bool, mtime: &mut i64, out: &mut Vec<RawEntry>| {
        if let Some(value) = path.take() {
            out.push(RawEntry {
                path: value,
                size: *size,
                is_dir: *is_dir,
                mtime_ms: *mtime,
            });
        }
        *size = 0;
        *is_dir = false;
        *mtime = 0;
    };

    for line in output.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            flush(&mut path, &mut size, &mut is_dir, &mut mtime, &mut entries);
            continue;
        }
        let Some((key, value)) = line.split_once(" = ") else {
            continue;
        };
        match key {
            "Path" => {
                if path.is_some() {
                    flush(&mut path, &mut size, &mut is_dir, &mut mtime, &mut entries);
                }
                path = Some(value.replace('/', "\\"));
            }
            "Size" => size = value.parse().unwrap_or(0),
            "Modified" => mtime = parse_datetime(value),
            "Folder" => is_dir = value.trim() == "+",
            "Attributes" => {
                if value.starts_with('D') {
                    is_dir = true;
                }
            }
            _ => {}
        }
    }
    flush(&mut path, &mut size, &mut is_dir, &mut mtime, &mut entries);
    entries
}

/// `2024-01-31 12:34:56` → epoch milliseconds (treated as local, good enough
/// for a date column).
fn parse_datetime(value: &str) -> i64 {
    let mut parts = value.split(' ');
    let date = parts.next().unwrap_or("");
    let time = parts.next().unwrap_or("");
    let mut fields = date.split('-').filter_map(|part| part.parse::<i64>().ok());
    let (year, month, day) = match (fields.next(), fields.next(), fields.next()) {
        (Some(year), Some(month), Some(day)) => (year, month, day),
        _ => return 0,
    };
    let mut clock = time.split(':').filter_map(|part| part.parse::<i64>().ok());
    let (hour, minute, second) = (
        clock.next().unwrap_or(0),
        clock.next().unwrap_or(0),
        clock.next().unwrap_or(0),
    );
    days_from_civil(year, month, day) * 86_400_000
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn list_raw(archive: &str) -> Result<Vec<RawEntry>, CoreError> {
    let tool = tool()?;
    let output = Command::new(tool)
        .args(["l", "-slt", "-ba", archive])
        .output()
        .map_err(|error| CoreError::internal(error.to_string()))?;
    if !output.status.success() {
        return Err(CoreError::bad_request(
            "ARCHIVE_UNREADABLE",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(parse_slt(&String::from_utf8_lossy(&output.stdout)))
}

fn to_entry(location: &Location, raw: &RawEntry) -> Entry {
    let name = raw.path.split('\\').last().unwrap_or(&raw.path).to_string();
    let path = build(&location.archive, &raw.path);
    Entry {
        ext: if raw.is_dir {
            String::new()
        } else {
            extension_of(&name)
        },
        hidden: name.starts_with('.'),
        name,
        path,
        kind: if raw.is_dir { "directory" } else { "file" },
        size: if raw.is_dir { 0 } else { raw.size },
        mtime_ms: raw.mtime_ms,
        birthtime_ms: raw.mtime_ms,
        readonly: true,
        is_link: false,
    }
}

pub fn list(target: &str) -> Result<(String, Option<String>, Vec<Entry>), CoreError> {
    let location = parse(target)?;
    let raw = list_raw(&location.archive)?;
    let prefix = if location.inner.is_empty() {
        String::new()
    } else {
        format!("{}\\", location.inner)
    };

    let mut names: std::collections::BTreeMap<String, Entry> = std::collections::BTreeMap::new();
    for item in &raw {
        if !prefix.is_empty() && !item.path.starts_with(&prefix) {
            continue;
        }
        let rest = &item.path[prefix.len()..];
        if rest.is_empty() {
            continue;
        }
        let mut parts = rest.splitn(2, '\\');
        let first = parts.next().unwrap_or("");
        let remainder = parts.next();
        if first.is_empty() {
            continue;
        }
        if remainder.is_some() {
            let inner = if prefix.is_empty() {
                first.to_string()
            } else {
                format!("{}{}", prefix, first)
            };
            names.entry(first.to_string()).or_insert_with(|| Entry {
                name: first.to_string(),
                path: build(&location.archive, &inner),
                kind: "directory",
                size: 0,
                mtime_ms: item.mtime_ms,
                birthtime_ms: item.mtime_ms,
                ext: String::new(),
                hidden: first.starts_with('.'),
                readonly: true,
                is_link: false,
            });
        } else {
            names.insert(first.to_string(), to_entry(&location, item));
        }
    }

    let mut entries: Vec<Entry> = names.into_values().collect();
    entries.sort_by(oriel_core::entry::compare_entries);

    let parent = if location.inner.is_empty() {
        None
    } else {
        let mut parts: Vec<&str> = location.inner.split('\\').collect();
        parts.pop();
        Some(build(&location.archive, &parts.join("\\")))
    };

    Ok((target.to_string(), parent, entries))
}

pub fn stat(target: &str) -> Result<Entry, CoreError> {
    let location = parse(target)?;
    if location.inner.is_empty() {
        let stat = oriel_core::entry::stat(&location.archive)?;
        return Ok(Entry {
            name: file_name_of(&location.archive),
            path: target.to_string(),
            kind: "directory",
            size: 0,
            mtime_ms: stat.mtime_ms,
            birthtime_ms: stat.birthtime_ms,
            ext: String::new(),
            hidden: false,
            readonly: true,
            is_link: false,
        });
    }
    let raw = list_raw(&location.archive)?;
    for item in &raw {
        if item.path.eq_ignore_ascii_case(&location.inner) {
            return Ok(to_entry(&location, item));
        }
    }
    Err(CoreError::not_found("归档中没有该项目"))
}

pub fn read_entry(target: &str, limit: u64) -> Result<(Vec<u8>, u64), CoreError> {
    let location = parse(target)?;
    let tool = tool()?;
    let output = Command::new(tool)
        .args(["x", "-so", &location.archive, &location.inner])
        .output()
        .map_err(|error| CoreError::internal(error.to_string()))?;
    if !output.status.success() {
        return Err(CoreError::bad_request("ARCHIVE_UNREADABLE", "无法读取归档中的文件"));
    }
    let size = output.stdout.len() as u64;
    let mut bytes = output.stdout;
    bytes.truncate(limit as usize);
    Ok((bytes, size))
}

pub fn extract(path: &str, target: &str, policy: &str) -> Result<Vec<String>, CoreError> {
    let archive = match path.strip_prefix(ARCHIVE_SCHEME) {
        Some(rest) => rest.split(SEPARATOR).next().unwrap_or(rest).to_string(),
        None => path.to_string(),
    };
    let tool = tool()?;
    let mut command = Command::new(tool);
    command.arg("x").arg("-y").arg(format!("-o{target}"));
    match policy {
        "skip" => {
            command.arg("-aos");
        }
        "overwrite" => {
            command.arg("-aoa");
        }
        _ => {
            command.arg("-aou");
        }
    }
    let output = command
        .arg(&archive)
        .output()
        .map_err(|error| CoreError::internal(error.to_string()))?;
    if !output.status.success() {
        return Err(CoreError::bad_request(
            "EXTRACT_FAILED",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(vec![target.to_string()])
}

pub fn create(sources: &[String], target: &str, name: &str) -> Result<String, CoreError> {
    let tool = tool()?;
    let destination = oriel_core::paths::join(target, name);
    let mut command = Command::new(tool);
    command.arg("a").arg("-tzip").arg(&destination);
    for source in sources {
        command.arg(source);
    }
    let output = command
        .output()
        .map_err(|error| CoreError::internal(error.to_string()))?;
    if !output.status.success() {
        return Err(CoreError::bad_request(
            "ARCHIVE_FAILED",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(destination)
}
