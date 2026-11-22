//! Disk cleanup analysis and whitelisted deletion.
//!
//! The UI can only ask for category ids. Every path that may be removed comes
//! from the fixed table in `specs()`, so this module never turns into a second,
//! unrestricted delete endpoint.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::UI::Shell::IsUserAnAdmin;

use crate::entry;
use crate::error::{CoreError, Result};
use crate::paths::join;
use crate::recycle;

/// Whole-drive folder walk budget. Long enough to finish on a normal system
/// drive, short enough that the request cannot hang forever.
const DRIVE_BUDGET: Duration = Duration::from_secs(45);
const CATEGORY_BUDGET: Duration = Duration::from_secs(30);
/// One directory in the heatmap may not eat the whole view budget.
const CHILD_BUDGET: Duration = Duration::from_secs(15);
const TREE_BUDGET: Duration = Duration::from_secs(75);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const MAX_DIR_NODES: usize = 300;
const MAX_FILE_NODES: usize = 200;
/// A handful of workers fill the heatmap from several folders at once, so the
/// big ones start growing immediately instead of waiting for name order. Kept
/// modest so the category scan still gets its share of the disk.
const TREE_WORKERS: usize = 4;
const LARGE_FILE: u64 = 200 * 1024 * 1024;
const MAX_LARGE_FILES: usize = 20;
const MAX_ERRORS: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCategory {
    pub id: String,
    pub title: String,
    pub detail: String,
    /// `safe` for regenerated caches, `caution` when deleting loses something.
    pub risk: &'static str,
    pub needs_admin: bool,
    pub available: bool,
    pub size: u64,
    pub files: u64,
    /// True when the walk hit its time budget.
    pub partial: bool,
    /// Where the category lives, for the expandable detail in the UI.
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderUsage {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub files: u64,
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// pagefile.sys and friends: shown for context, never suggested for deletion.
    pub system: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub drive: String,
    pub total: u64,
    pub free: u64,
    pub used: u64,
    /// Whether the app runs elevated; system-level categories may fail without it.
    pub elevated: bool,
    pub categories: Vec<CleanupCategory>,
    pub folders: Vec<FolderUsage>,
    pub large_files: Vec<LargeFile>,
    /// True when part of the drive could not be measured in time.
    pub partial: bool,
    pub scanned_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItemResult {
    pub id: String,
    pub title: String,
    pub freed: u64,
    pub deleted: u64,
    pub failed: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub freed: u64,
    pub deleted: u64,
    pub failed: u64,
    pub items: Vec<CleanupItemResult>,
}

/// Events for the heatmap stream. The UI lays out a node as soon as its first
/// partial size arrives, so a 60-second scan never feels like a blank wait.
#[derive(Debug, Clone)]
pub enum CleanupEvent {
    Meta {
        path: String,
        parent: Option<String>,
        drive: String,
        total: u64,
        free: u64,
        used: u64,
        elevated: bool,
    },
    Category(CleanupCategory),
    Scan {
        name: String,
        path: String,
    },
    Node {
        name: String,
        path: String,
        kind: &'static str,
        size: u64,
        files: u64,
        complete: bool,
        partial: bool,
    },
    Done {
        partial: bool,
        scanned_at: i64,
    },
    Error(String),
}

enum PathRule {
    /// Remove the folder itself and everything inside.
    Tree(String),
    /// Remove the folder's children but keep the folder.
    Contents(String),
    /// Remove one file.
    File(String),
    /// Remove files in a folder whose name starts with one of the prefixes.
    Prefixes(String, Vec<String>),
}

struct CategorySpec {
    id: &'static str,
    title: &'static str,
    detail: &'static str,
    risk: &'static str,
    needs_admin: bool,
    rules: Vec<PathRule>,
}

fn env_path(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn specs() -> Vec<CategorySpec> {
    let windir = env_path("WINDIR").unwrap_or_else(|| "C:\\Windows".to_string());
    let program_data = env_path("ProgramData").unwrap_or_else(|| "C:\\ProgramData".to_string());
    let local = env_path("LOCALAPPDATA");
    let mut out = Vec::new();

    if let Some(temp) = env_path("TEMP").or_else(|| env_path("TMP")) {
        out.push(CategorySpec {
            id: "user-temp",
            title: "用户临时文件",
            detail: "程序运行期间产生的临时文件，没有被占用时都可以删除",
            risk: "safe",
            needs_admin: false,
            rules: vec![PathRule::Contents(temp)],
        });
    }

    out.push(CategorySpec {
        id: "windows-temp",
        title: "系统临时文件",
        detail: "Windows 和安装程序留下的临时文件，建议重启后再清理",
        risk: "safe",
        needs_admin: true,
        rules: vec![PathRule::Contents(join(&windir, "Temp"))],
    });

    out.push(CategorySpec {
        id: "windows-update",
        title: "Windows 更新缓存",
        detail: "已安装更新的安装包缓存，删除后不影响已经装好的更新",
        risk: "safe",
        needs_admin: true,
        rules: vec![PathRule::Contents(join(
            &windir,
            "SoftwareDistribution\\Download",
        ))],
    });

    out.push(CategorySpec {
        id: "delivery-optimization",
        title: "传递优化缓存",
        detail: "用于局域网共享更新的缓存，删除后系统会按需重新下载",
        risk: "safe",
        needs_admin: true,
        rules: vec![PathRule::Contents(join(
            &windir,
            "ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization",
        ))],
    });

    let windows_old = join(&windir, "Windows.old");
    if Path::new(&windows_old).exists() {
        out.push(CategorySpec {
            id: "windows-old",
            title: "旧版 Windows 备份",
            detail: "升级前的系统备份，删除后无法回滚到上一个 Windows 版本",
            risk: "caution",
            needs_admin: true,
            rules: vec![PathRule::Tree(windows_old)],
        });
    }

    out.push(CategorySpec {
        id: "crash-dumps",
        title: "崩溃转储",
        detail: "系统蓝屏和程序崩溃时留下的内存转储文件",
        risk: "safe",
        needs_admin: true,
        rules: vec![
            PathRule::File(join(&windir, "MEMORY.DMP")),
            PathRule::Contents(join(&windir, "Minidump")),
        ],
    });

    let mut wer_rules = vec![
        PathRule::Contents(join(
            &program_data,
            "Microsoft\\Windows\\WER\\ReportQueue",
        )),
        PathRule::Contents(join(
            &program_data,
            "Microsoft\\Windows\\WER\\ReportArchive",
        )),
    ];
    if Path::new(&program_data).exists() {
        out.push(CategorySpec {
            id: "system-error-reports",
            title: "系统错误报告",
            detail: "ProgramData 下的错误报告，删除需要管理员权限",
            risk: "safe",
            needs_admin: true,
            rules: std::mem::take(&mut wer_rules),
        });
    }

    let mut user_wer_rules = Vec::new();
    if let Some(local) = local.as_deref() {
        user_wer_rules.push(PathRule::Contents(join(
            local,
            "Microsoft\\Windows\\WER\\ReportQueue",
        )));
        user_wer_rules.push(PathRule::Contents(join(
            local,
            "Microsoft\\Windows\\WER\\ReportArchive",
        )));
    }
    if !user_wer_rules.is_empty() {
        out.push(CategorySpec {
            id: "error-reports",
            title: "错误报告",
            detail: "当前用户的 Windows 错误报告暂存和归档文件",
            risk: "safe",
            needs_admin: false,
            rules: user_wer_rules,
        });
    }

    if let Some(local) = local.as_deref() {
        out.push(CategorySpec {
            id: "thumbnails",
            title: "缩略图和图标缓存",
            detail: "资源管理器生成的缓存，删除后会自动重建（第一次打开会稍慢）",
            risk: "safe",
            needs_admin: false,
            rules: vec![PathRule::Prefixes(
                join(local, "Microsoft\\Windows\\Explorer"),
                vec!["thumbcache_".to_string(), "iconcache_".to_string()],
            )],
        });
    }

    out.push(CategorySpec {
        id: "windows-logs",
        title: "系统日志",
        detail: "Windows 组件写下的日志和安装记录",
        risk: "safe",
        needs_admin: true,
        rules: vec![PathRule::Contents(join(&windir, "Logs"))],
    });

    out.push(CategorySpec {
        id: "prefetch",
        title: "预读取数据",
        detail: "启动加速用的预读文件，删除后前几次启动会略慢，系统会自动重建",
        risk: "caution",
        needs_admin: true,
        rules: vec![PathRule::Contents(join(&windir, "Prefetch"))],
    });

    out
}

fn normalize_drive(value: &str) -> Result<String> {
    let trimmed = value.trim().trim_end_matches(['\\', '/']);
    let letter = match trimmed.chars().next() {
        Some(letter) if letter.is_ascii_alphabetic() && trimmed.len() <= 2 => {
            letter.to_ascii_uppercase()
        }
        _ => return Err(CoreError::bad_request("INVALID_DRIVE", "磁盘盘符无效")),
    };
    Ok(format!("{letter}:\\"))
}

fn is_system_file(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "pagefile.sys" | "hiberfil.sys" | "swapfile.sys" | "dumpstack.log" | "dumpstack.log.tmp"
    )
}

/// Recursive size walk. Returns false when the deadline cut it short.
fn walk(
    directory: &str,
    deadline: Instant,
    large: &mut Vec<LargeFile>,
    size: &mut u64,
    files: &mut u64,
    denied: &mut bool,
) -> bool {
    if Instant::now() > deadline {
        return false;
    }
    let entries = match entry::enumerate(directory) {
        Ok(entries) => entries,
        // Unreadable folders are skipped but flagged, so a protected system
        // folder does not look like an empty one.
        Err(_) => {
            *denied = true;
            return true;
        }
    };

    for item in entries {
        if item.is_link() {
            continue;
        }
        if item.is_dir() {
            *files += 1;
            let path = join(directory, &item.name);
            if !walk(&path, deadline, large, size, files, denied) {
                return false;
            }
        } else {
            *size = size.saturating_add(item.size);
            *files += 1;
            if item.size >= LARGE_FILE {
                large.push(LargeFile {
                    name: item.name.clone(),
                    path: join(directory, &item.name),
                    size: item.size,
                    system: is_system_file(&item.name),
                });
            }
        }
    }
    true
}

fn measure_rule(rule: &PathRule, deadline: Instant) -> (u64, u64, bool, Option<String>) {
    match rule {
        PathRule::Tree(path) | PathRule::Contents(path) => {
            if !Path::new(path).exists() {
                return (0, 0, false, None);
            }
            let mut size = 0;
            let mut files = 0;
            let mut denied = false;
            let completed = walk(
                path,
                deadline,
                &mut Vec::new(),
                &mut size,
                &mut files,
                &mut denied,
            );
            (size, files, !completed || denied, Some(path.clone()))
        }
        PathRule::File(path) => {
            let meta = match std::fs::symlink_metadata(path) {
                Ok(meta) if meta.is_file() => meta,
                _ => return (0, 0, false, None),
            };
            (meta.len(), 1, false, Some(path.clone()))
        }
        PathRule::Prefixes(directory, prefixes) => {
            let entries = match entry::enumerate(directory) {
                Ok(entries) => entries,
                Err(_) => return (0, 0, false, None),
            };
            let mut size = 0;
            let mut files = 0;
            for item in entries {
                if item.is_dir() {
                    continue;
                }
                let lower = item.name.to_ascii_lowercase();
                if prefixes.iter().any(|prefix| lower.starts_with(prefix)) {
                    size += item.size;
                    files += 1;
                }
            }
            (size, files, false, Some(directory.clone()))
        }
    }
}

fn measure_spec(spec: &CategorySpec, deadline: Instant) -> CleanupCategory {
    let mut size = 0u64;
    let mut files = 0u64;
    let mut partial = false;
    let mut paths = Vec::new();

    for rule in &spec.rules {
        if Instant::now() > deadline {
            partial = true;
            break;
        }
        let (rule_size, rule_files, rule_partial, path) = measure_rule(rule, deadline);
        size = size.saturating_add(rule_size);
        files += rule_files;
        partial |= rule_partial;
        if let Some(path) = path {
            paths.push(path);
        }
    }

    CleanupCategory {
        id: spec.id.to_string(),
        title: spec.title.to_string(),
        detail: spec.detail.to_string(),
        risk: spec.risk,
        needs_admin: spec.needs_admin,
        available: !paths.is_empty(),
        size,
        files,
        partial,
        paths,
    }
}

fn recycle_category() -> CleanupCategory {
    let bin = recycle::list();
    CleanupCategory {
        id: "recycle-bin".to_string(),
        title: "回收站".to_string(),
        detail: "已删除但还没有清空的文件".to_string(),
        risk: "safe",
        needs_admin: false,
        available: !bin.items.is_empty(),
        size: bin.total,
        files: bin.items.len() as u64,
        partial: !bin.skipped_drives.is_empty(),
        paths: Vec::new(),
    }
}

/// Detailed analysis of one drive: cleanup categories, top-level folders and
/// the largest files.
pub fn analyze(drive: &str) -> Result<CleanupReport> {
    let root = normalize_drive(drive)?;
    let info = crate::drives::list(true)
        .into_iter()
        .find(|item| item.path.eq_ignore_ascii_case(&root))
        .ok_or_else(|| CoreError::not_found("没有找到这个磁盘"))?;

    let mut categories = vec![recycle_category()];
    let category_deadline = Instant::now() + CATEGORY_BUDGET;
    for spec in specs() {
        if Instant::now() > category_deadline {
            break;
        }
        categories.push(measure_spec(&spec, category_deadline));
    }

    let deadline = Instant::now() + DRIVE_BUDGET;
    let mut folders: Vec<FolderUsage> = Vec::new();
    let mut large: Vec<LargeFile> = Vec::new();
    let mut partial = false;

    if let Ok(entries) = entry::enumerate(&root) {
        for item in &entries {
            if !item.is_dir() && item.size >= LARGE_FILE {
                large.push(LargeFile {
                    name: item.name.clone(),
                    path: join(&root, &item.name),
                    size: item.size,
                    system: is_system_file(&item.name),
                });
            }
        }

        for item in entries.iter().filter(|item| item.is_dir() && !item.is_link()) {
            if Instant::now() > deadline {
                partial = true;
                break;
            }
            let path = join(&root, &item.name);
            let mut size = 0;
            let mut files = 0;
            let mut denied = false;
            let completed = walk(
                &path,
                deadline,
                &mut large,
                &mut size,
                &mut files,
                &mut denied,
            );
            folders.push(FolderUsage {
                name: item.name.clone(),
                path,
                size,
                files,
                partial: !completed || denied,
            });
            if !completed {
                partial = true;
            }
        }
    } else {
        partial = true;
    }

    folders.sort_by(|a, b| b.size.cmp(&a.size));
    large.sort_by(|a, b| b.size.cmp(&a.size));
    large.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));
    large.truncate(MAX_LARGE_FILES);

    Ok(CleanupReport {
        drive: root,
        total: info.total,
        free: info.free,
        used: info.used,
        elevated: unsafe { IsUserAnAdmin().as_bool() },
        categories,
        folders,
        large_files: large,
        partial,
        scanned_at: crate::now_millis(),
    })
}

#[derive(Default)]
struct DeleteAcc {
    freed: u64,
    deleted: u64,
    failed: u64,
    errors: Vec<String>,
}

impl DeleteAcc {
    fn push_error(&mut self, message: String) {
        if self.errors.len() < MAX_ERRORS {
            self.errors.push(message);
        }
    }
}

fn clear_readonly(path: &Path) {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(path, permissions);
        }
    }
}

fn delete_tree(path: &Path, acc: &mut DeleteAcc) {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return,
    };

    if metadata.file_type().is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for child in entries.flatten() {
                delete_tree(&child.path(), acc);
            }
        }
        clear_readonly(path);
        if let Err(error) = std::fs::remove_dir(path) {
            acc.failed += 1;
            acc.push_error(format!("{}: {error}", path.display()));
        }
    } else if metadata.file_type().is_file() {
        let size = metadata.len();
        clear_readonly(path);
        match std::fs::remove_file(path) {
            Ok(()) => {
                acc.freed = acc.freed.saturating_add(size);
                acc.deleted += 1;
            }
            Err(error) => {
                acc.failed += 1;
                acc.push_error(format!("{}: {error}", path.display()));
            }
        }
    }
}

fn delete_rule(rule: &PathRule, acc: &mut DeleteAcc) {
    match rule {
        PathRule::Tree(path) => delete_tree(Path::new(path), acc),
        PathRule::Contents(path) => {
            if let Ok(entries) = std::fs::read_dir(path) {
                for child in entries.flatten() {
                    delete_tree(&child.path(), acc);
                }
            }
        }
        PathRule::File(path) => delete_tree(Path::new(path), acc),
        PathRule::Prefixes(directory, prefixes) => {
            if let Ok(entries) = entry::enumerate(directory) {
                for item in entries {
                    if item.is_dir() {
                        continue;
                    }
                    let lower = item.name.to_ascii_lowercase();
                    if prefixes.iter().any(|prefix| lower.starts_with(prefix)) {
                        delete_tree(&Path::new(directory).join(&item.name), acc);
                    }
                }
            }
        }
    }
}

fn normalize_view_path(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CoreError::invalid_path("路径不能为空"));
    }
    let mut path = trimmed.to_string();
    while path.len() > 3 && (path.ends_with('\\') || path.ends_with('/')) {
        path.pop();
    }
    if path.len() == 2 && path.ends_with(':') {
        path.push('\\');
    }
    Ok(path)
}

/// Walks one directory subtree, calling `progress` with the running totals.
/// Returns `(size, files, completed)`; a false `completed` means the deadline
/// or a cancelled stream stopped the walk.
fn measure_child(
    path: &str,
    deadline: Instant,
    progress: &mut dyn FnMut(u64, u64) -> bool,
) -> (u64, u64, bool) {
    let mut stack = vec![path.to_string()];
    let mut size = 0u64;
    let mut files = 0u64;
    let mut last = Instant::now();

    while let Some(directory) = stack.pop() {
        if Instant::now() > deadline {
            return (size, files, false);
        }
        let entries = match entry::enumerate(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for item in entries {
            if item.is_link() {
                continue;
            }
            if item.is_dir() {
                files += 1;
                stack.push(join(&directory, &item.name));
            } else {
                size = size.saturating_add(item.size);
                files += 1;
            }
        }
        if last.elapsed() >= PROGRESS_INTERVAL {
            if !progress(size, files) {
                return (size, files, false);
            }
            last = Instant::now();
        }
    }

    (size, files, true)
}

/// Streams the immediate children of `path` with partial sizes as they are
/// measured. The callback returns false to cancel (client went away).
pub fn stream_tree<F>(path: &str, emit: F)
where
    F: Fn(CleanupEvent) -> bool + Sync,
{
    let root = match normalize_view_path(path) {
        Ok(root) => root,
        Err(error) => {
            let _ = emit(CleanupEvent::Error(error.message));
            return;
        }
    };

    if !entry::is_directory(&root) {
        let _ = emit(CleanupEvent::Error("找不到这个文件夹".to_string()));
        return;
    }

    let drive = crate::drives::drive_for_path(&root).unwrap_or_else(|| "C:\\".to_string());
    let info = crate::drives::list(false)
        .into_iter()
        .find(|item| item.path.eq_ignore_ascii_case(&drive));
    let (total, free, used) = info
        .map(|item| (item.total, item.free, item.used))
        .unwrap_or((0, 0, 0));

    if !emit(CleanupEvent::Meta {
        path: root.clone(),
        parent: crate::paths::parent_of(&root),
        drive,
        total,
        free,
        used,
        elevated: unsafe { IsUserAnAdmin().as_bool() },
    }) {
        return;
    }

    let entries = match entry::enumerate(&root) {
        Ok(entries) => entries,
        Err(_) => {
            let _ = emit(CleanupEvent::Error("无法读取这个文件夹".to_string()));
            return;
        }
    };

    let deadline = Instant::now() + TREE_BUDGET;
    let mut partial = false;

    // Files are instant to list, so they give the heatmap something to render
    // before the first big directory finishes.
    let mut files: Vec<&entry::RawEntry> = entries
        .iter()
        .filter(|item| !item.is_dir() && !item.is_link())
        .collect();
    files.sort_by(|a, b| b.size.cmp(&a.size));
    if files.len() > MAX_FILE_NODES {
        files.truncate(MAX_FILE_NODES);
        partial = true;
    }
    for item in files {
        if !emit(CleanupEvent::Node {
            name: item.name.clone(),
            path: join(&root, &item.name),
            kind: "file",
            size: item.size,
            files: 1,
            complete: true,
            partial: false,
        }) {
            return;
        }
    }

    let mut dirs: Vec<(String, String)> = entries
        .iter()
        .filter(|item| item.is_dir() && !item.is_link())
        .map(|item| (item.name.clone(), join(&root, &item.name)))
        .collect();
    dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    if dirs.len() > MAX_DIR_NODES {
        dirs.truncate(MAX_DIR_NODES);
        partial = true;
    }

    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let partial_flag = std::sync::atomic::AtomicBool::new(partial);
    let next = std::sync::atomic::AtomicUsize::new(0);

    std::thread::scope(|scope| {
        for _ in 0..TREE_WORKERS.min(dirs.len().max(1)) {
            scope.spawn(|| {
                loop {
                    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some((name, child)) = dirs.get(index) else {
                        break;
                    };
                    if Instant::now() > deadline {
                        partial_flag.store(true, std::sync::atomic::Ordering::Relaxed);
                        break;
                    }
                    if !emit(CleanupEvent::Scan {
                        name: name.clone(),
                        path: child.clone(),
                    }) {
                        cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
                        break;
                    }

                    let child_deadline = deadline.min(Instant::now() + CHILD_BUDGET);
                    let (size, file_count, completed) = {
                        let mut progress = |size: u64, files: u64| {
                            emit(CleanupEvent::Node {
                                name: name.clone(),
                                path: child.clone(),
                                kind: "directory",
                                size,
                                files,
                                complete: false,
                                partial: false,
                            })
                        };
                        measure_child(child, child_deadline, &mut progress)
                    };
                    if !completed {
                        partial_flag.store(true, std::sync::atomic::Ordering::Relaxed);
                    }

                    if !emit(CleanupEvent::Node {
                        name: name.clone(),
                        path: child.clone(),
                        kind: "directory",
                        size,
                        files: file_count,
                        complete: true,
                        partial: !completed,
                    }) {
                        cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
                        break;
                    }
                }
            });
        }
    });

    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }

    let _ = emit(CleanupEvent::Done {
        partial: partial_flag.load(std::sync::atomic::Ordering::Relaxed),
        scanned_at: crate::now_millis(),
    });
}

/// Measures one category while emitting growing snapshots, so the suggestion
/// panel fills in at the same pace as the heatmap.
fn measure_spec_streaming<F: FnMut(CleanupCategory) -> bool>(
    spec: &CategorySpec,
    deadline: Instant,
    mut emit_category: F,
) -> bool {
    let mut size = 0u64;
    let mut files = 0u64;
    let mut partial = false;
    let mut paths: Vec<String> = Vec::new();

    let snapshot = |size: u64, files: u64, partial: bool, paths: &[String]| CleanupCategory {
        id: spec.id.to_string(),
        title: spec.title.to_string(),
        detail: spec.detail.to_string(),
        risk: spec.risk,
        needs_admin: spec.needs_admin,
        available: !paths.is_empty(),
        size,
        files,
        partial,
        paths: paths.to_vec(),
    };

    for rule in &spec.rules {
        if Instant::now() > deadline {
            partial = true;
            break;
        }
        match rule {
            PathRule::Tree(path) | PathRule::Contents(path) => {
                if !Path::new(path).exists() {
                    continue;
                }
                paths.push(path.clone());
                let (rule_size, rule_files, completed) = {
                    let mut progress = |current: u64, current_files: u64| {
                        emit_category(snapshot(
                            size + current,
                            files + current_files,
                            true,
                            &paths,
                        ))
                    };
                    measure_child(path, deadline, &mut progress)
                };
                size = size.saturating_add(rule_size);
                files += rule_files;
                if !completed {
                    partial = true;
                }
            }
            PathRule::File(path) => {
                if let Ok(metadata) = std::fs::symlink_metadata(path) {
                    if metadata.is_file() {
                        paths.push(path.clone());
                        size = size.saturating_add(metadata.len());
                        files += 1;
                    }
                }
            }
            PathRule::Prefixes(directory, prefixes) => {
                if let Ok(entries) = entry::enumerate(directory) {
                    paths.push(directory.clone());
                    for item in entries {
                        if item.is_dir() {
                            continue;
                        }
                        let lower = item.name.to_ascii_lowercase();
                        if prefixes.iter().any(|prefix| lower.starts_with(prefix)) {
                            size = size.saturating_add(item.size);
                            files += 1;
                        }
                    }
                }
            }
        }

        if !emit_category(snapshot(size, files, partial, &paths)) {
            return false;
        }
    }

    emit_category(snapshot(size, files, partial, &paths))
}

/// Streams the cleanup categories, smallest work first, so suggestions appear
/// while the heatmap is still walking the drive.
pub fn stream_categories<F: FnMut(CleanupEvent) -> bool>(mut emit: F) {
    if !emit(CleanupEvent::Category(recycle_category())) {
        return;
    }

    let deadline = Instant::now() + CATEGORY_BUDGET;
    for spec in specs() {
        if Instant::now() > deadline {
            break;
        }
        if !measure_spec_streaming(&spec, deadline, |category| {
            emit(CleanupEvent::Category(category))
        }) {
            return;
        }
    }

    let _ = emit(CleanupEvent::Done {
        partial: false,
        scanned_at: crate::now_millis(),
    });
}

/// Recursive permanent delete with readonly handling. Returns freed bytes,
/// deleted file count and the errors the delete could not get past.
pub fn delete_path(target: &str) -> (u64, u64, Vec<String>) {
    let mut acc = DeleteAcc::default();
    delete_tree(Path::new(target), &mut acc);
    (acc.freed, acc.deleted, acc.errors)
}

/// Deletes the selected categories. Unknown ids are ignored on purpose.
pub fn clean(ids: &[String]) -> CleanupResult {
    let specs = specs();
    let mut items = Vec::new();
    let mut total_freed = 0u64;
    let mut total_deleted = 0u64;
    let mut total_failed = 0u64;

    for id in ids {
        let mut item = CleanupItemResult {
            id: id.clone(),
            title: String::new(),
            freed: 0,
            deleted: 0,
            failed: 0,
            errors: Vec::new(),
        };

        if id == "recycle-bin" {
            let before = recycle::list().total;
            let (purged, skipped) = recycle::empty();
            item.title = "回收站".to_string();
            item.freed = before;
            item.deleted = purged as u64;
            item.failed = skipped as u64;
        } else if let Some(spec) = specs.iter().find(|spec| spec.id == id) {
            item.title = spec.title.to_string();
            let mut acc = DeleteAcc::default();
            for rule in &spec.rules {
                delete_rule(rule, &mut acc);
            }
            item.freed = acc.freed;
            item.deleted = acc.deleted;
            item.failed = acc.failed;
            item.errors = acc.errors;
        } else {
            continue;
        }

        total_freed = total_freed.saturating_add(item.freed);
        total_deleted += item.deleted;
        total_failed += item.failed;
        items.push(item);
    }

    CleanupResult {
        freed: total_freed,
        deleted: total_deleted,
        failed: total_failed,
        items,
    }
}
