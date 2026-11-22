//! Write operations: create, rename, copy, move, delete, launch.
//!
//! The transfer loop is chunked so a task can report bytes and react to
//! pause/cancel between 1 MiB blocks instead of after the whole tree.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::UI::Shell::{
    SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    SHFILEOPSTRUCTW,
};

use crate::entry;
use crate::error::{CoreError, Result};
use crate::paths::{self, join, validate_entry_name};

const CHUNK: usize = 1024 * 1024;

/// Cancellation and pause hooks shared by every copy/move.
pub trait Control: Send + Sync {
    fn check(&self) -> Result<()>;
    fn is_paused(&self) -> bool {
        false
    }
}

pub struct Free;

impl Control for Free {
    fn check(&self) -> Result<()> {
        Ok(())
    }
}

fn conflict(name: &str) -> CoreError {
    CoreError::new(409, "CONFLICT", format!("“{name}” 已存在"))
}

fn wait_if_paused(control: &dyn Control) -> Result<()> {
    while control.is_paused() {
        control.check()?;
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    control.check()
}

pub fn create_folder(parent: &str, name: &str) -> Result<String> {
    let name = validate_entry_name(name)?;
    let stat = entry::stat(parent)?;
    if stat.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "目标不是文件夹"));
    }
    let destination = join(parent, &name);
    if entry::exists(&destination) {
        return Err(conflict(&name));
    }
    fs::create_dir(&destination)?;
    Ok(destination)
}

pub fn create_file(parent: &str, name: &str, content: &[u8]) -> Result<String> {
    let name = validate_entry_name(name)?;
    let stat = entry::stat(parent)?;
    if stat.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "目标不是文件夹"));
    }
    let destination = join(parent, &name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                conflict(&name)
            } else {
                CoreError::from(error)
            }
        })?;
    file.write_all(content)?;
    Ok(destination)
}

pub fn rename_entry(target: &str, new_name: &str) -> Result<String> {
    let name = validate_entry_name(new_name)?;
    let destination = join(&paths::parent_of(target).unwrap_or_else(|| paths::root_of(target)), &name);
    if paths::is_same_path(target, &destination) && paths::file_name_of(target) == name {
        return Ok(target.to_string());
    }
    entry::stat(target)?;
    if entry::exists(&destination) && !paths::is_same_path(target, &destination) {
        return Err(conflict(&name));
    }
    fs::rename(target, &destination)?;
    Ok(destination)
}

/// Two-phase batch rename: every source moves to a temporary name first, so
/// swaps (`a → b, b → a`) and case-only changes work on a case-insensitive
/// volume. Everything is validated before the first file is touched.
pub fn batch_rename(items: &[(String, String)]) -> Result<Vec<(String, String)>> {
    if items.is_empty() {
        return Err(CoreError::bad_request("INVALID_NAME", "没有要重命名的项目"));
    }

    let sources: std::collections::HashSet<String> = items
        .iter()
        .map(|(path, _)| path.to_ascii_lowercase())
        .collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut moves: Vec<(String, String)> = Vec::new();

    for (path, name) in items {
        let name = validate_entry_name(name)?;
        let parent = paths::parent_of(path)
            .ok_or_else(|| CoreError::invalid_path("不能重命名磁盘根目录"))?;
        let destination = join(&parent, &name);
        if paths::file_name_of(path) == name {
            continue;
        }
        let key = destination.to_ascii_lowercase();
        if !seen.insert(key.clone()) {
            return Err(CoreError::new(
                409,
                "CONFLICT",
                format!("“{name}” 出现了两次，重命名后会互相覆盖"),
            ));
        }
        entry::stat(path)?;
        if !sources.contains(&key) && entry::exists(&destination) {
            return Err(conflict(&name));
        }
        moves.push((path.clone(), destination));
    }

    if moves.is_empty() {
        return Ok(Vec::new());
    }

    let token = format!("{}-{}", std::process::id(), crate::now_millis());
    let mut staged: Vec<(String, String, String)> = Vec::new();
    let mut finalised: Vec<(String, String)> = Vec::new();

    let result = (|| -> Result<()> {
        for (index, (from, to)) in moves.iter().enumerate() {
            let parent = paths::parent_of(from).unwrap_or_default();
            let temp = join(&parent, &format!(".oriel-rename-{token}-{index}"));
            fs::rename(from, &temp)?;
            staged.push((temp, from.clone(), to.clone()));
        }
        for (temp, from, to) in &staged {
            fs::rename(temp, to)?;
            finalised.push((from.clone(), to.clone()));
        }
        Ok(())
    })();

    if let Err(error) = result {
        for (from, to) in finalised.iter().rev() {
            let _ = fs::rename(to, from);
        }
        for (temp, from, _) in staged.iter() {
            let _ = fs::rename(temp, from);
        }
        return Err(error);
    }

    Ok(moves)
}

fn copy_file(
    source: &Path,
    destination: &Path,
    control: &dyn Control,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<()> {
    let mut reader = File::open(source)?;
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut buffer = vec![0u8; CHUNK];
    loop {
        control.check()?;
        wait_if_paused(control)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        on_bytes(read as u64);
    }
    writer.flush()?;
    Ok(())
}

/// Recursive copy. Symlinks are copied as files/directories by content, which
/// matches what Explorer does when the target is on another volume.
pub fn copy_tree(
    source: &str,
    destination: &str,
    control: &dyn Control,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<()> {
    let stat = entry::stat(source)?;
    if stat.kind != "directory" {
        return copy_file(Path::new(source), Path::new(destination), control, on_bytes);
    }

    fs::create_dir_all(destination)?;
    for item in entry::enumerate(source)? {
        let from = join(source, &item.name);
        let to = join(destination, &item.name);
        copy_tree(&from, &to, control, on_bytes)?;
    }
    Ok(())
}

pub fn move_entry(
    source: &str,
    destination: &str,
    control: &dyn Control,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(17) => {
            // ERROR_NOT_SAME_DEVICE: copy across volumes, then drop the source.
            copy_tree(source, destination, control, on_bytes)?;
            remove_permanent(source)?;
            Ok(())
        }
        Err(error) => Err(CoreError::from(error)),
    }
}

pub fn remove_permanent(target: &str) -> Result<()> {
    paths::assert_safe_to_delete(target)?;
    let stat = entry::stat(target)?;
    if stat.kind == "directory" {
        fs::remove_dir_all(target)?;
    } else {
        fs::remove_file(target)?;
    }
    Ok(())
}

fn wide_list(paths: &[String]) -> Vec<u16> {
    let mut buffer: Vec<u16> = Vec::new();
    for path in paths {
        buffer.extend(path.encode_utf16());
        buffer.push(0);
    }
    buffer.push(0);
    buffer
}

/// Sends the selection to the recycle bin through the shell's own operation
/// queue, which keeps the undo record and the `$I` sidecar in sync.
pub fn delete_to_recycle(paths_to_delete: &[String]) -> Result<u32> {
    for target in paths_to_delete {
        paths::assert_safe_to_delete(target)?;
        entry::stat(target)?;
    }
    let from = wide_list(paths_to_delete);
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: 3, // FO_DELETE
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0) as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut operation) };
    if code != 0 {
        return Err(CoreError::internal(format!(
            "删除失败（shell 错误码 {code}）"
        )));
    }
    if operation.fAnyOperationsAborted.as_bool() {
        return Err(CoreError::new(499, "CANCELLED", "操作已取消"));
    }
    Ok(paths_to_delete.len() as u32)
}

pub fn open_with_system(target: &str) -> Result<()> {
    entry::stat(target)?;
    let _ = std::process::Command::new("explorer.exe").arg(target).spawn();
    Ok(())
}

pub fn reveal_in_system(target: &str) -> Result<()> {
    entry::stat(target)?;
    let _ = std::process::Command::new("explorer.exe")
        .arg(format!("/select,{target}"))
        .spawn();
    Ok(())
}

pub fn open_terminal(target: &str) -> Result<()> {
    entry::stat(target)?;
    let started = std::process::Command::new("wt.exe")
        .args(["-d", target])
        .spawn();
    if started.is_err() {
        let _ = std::process::Command::new("powershell.exe")
            .args(["-NoExit", "-Command", &format!("Set-Location -LiteralPath '{target}'")])
            .current_dir(target)
            .spawn();
    }
    Ok(())
}
