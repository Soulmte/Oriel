//! Installed-application inventory, uninstaller launching and leftover removal.
//!
//! The web client never names a registry key or a directory to delete. Both the
//! inventory and the leftover candidates are computed here, and `clean` only
//! accepts the ids of candidates it can recompute, so this module stays a
//! narrow tool instead of becoming an unrestricted delete endpoint.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER,
    ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, STILL_ACTIVE,
};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyW, RegDeleteTreeW, RegEnumKeyExW, RegOpenKeyExW,
    RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY,
    REG_DWORD, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{
    IsUserAnAdmin, ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::entry;
use crate::error::{CoreError, Result};
use crate::paths::join;

/// Measuring a multi-gigabyte install folder must not hang the request.
const MEASURE_BUDGET: Duration = Duration::from_secs(8);
/// A pathological DisplayName cannot produce an endless candidate scan.
const MAX_PATH_CANDIDATES: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub install_location: String,
    pub uninstall_string: String,
    pub quiet_uninstall_string: String,
    pub estimated_size: u64,
    /// Best known installed size: measured when available, otherwise the
    /// registry's `EstimatedSize`.
    pub size: u64,
    pub size_partial: bool,
    pub size_measured: bool,
    pub icon_path: String,
    pub install_date: String,
    /// `machine` for HKLM entries, `user` for HKCU entries.
    pub scope: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppList {
    pub items: Vec<InstalledApp>,
    pub elevated: bool,
    pub scanned_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverItem {
    pub id: String,
    /// `registry`, `directory` or `file`.
    pub kind: &'static str,
    pub label: String,
    /// Registry key or filesystem path, shown in the UI.
    pub detail: String,
    pub size: u64,
    pub files: u64,
    pub needs_admin: bool,
    /// True when the size walk hit its budget.
    pub partial: bool,
    pub risk: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverReport {
    pub app: InstalledApp,
    pub items: Vec<LeftoverItem>,
    pub total: u64,
    pub elevated: bool,
    pub scanned_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanItem {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub freed: u64,
    pub deleted: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanReport {
    pub freed: u64,
    pub deleted: u64,
    pub failed: u64,
    pub items: Vec<CleanItem>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Hive {
    Machine,
    User,
}

impl Hive {
    fn root(self) -> HKEY {
        match self {
            Hive::Machine => HKEY_LOCAL_MACHINE,
            Hive::User => HKEY_CURRENT_USER,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Hive::Machine => "hklm",
            Hive::User => "hkcu",
        }
    }

    fn scope(self) -> &'static str {
        match self {
            Hive::Machine => "machine",
            Hive::User => "user",
        }
    }

    fn from_id(value: &str) -> Option<Self> {
        match value {
            "hklm" => Some(Hive::Machine),
            "hkcu" => Some(Hive::User),
            _ => None,
        }
    }
}

enum Target {
    Registry(Hive, String),
    Path(String),
}

struct Candidate {
    item: LeftoverItem,
    target: Target,
}

/// Every installed program, newest inventory each call.
///
/// `with_sizes` applies measured sizes from the size cache. Measuring itself
/// happens in `measure_sizes`, so the inventory stays fast on first load.
pub fn list(with_sizes: bool) -> AppList {
    let mut items: Vec<InstalledApp> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for (hive, base) in uninstall_roots() {
        let Some(key) = open_key(hive, base) else {
            continue;
        };
        for subkey in subkeys(key) {
            let path = format!("{base}\\{subkey}");
            if let Some(app) = read_app(hive, &path) {
                if seen.insert(app.id.to_ascii_lowercase()) {
                    items.push(app);
                }
            }
        }
        close_key(key);
    }

    if with_sizes {
        for app in items.iter_mut() {
            attach_cached_size(app);
        }
    }

    items.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.publisher.cmp(&right.publisher))
    });

    AppList {
        items,
        elevated: elevated(),
        scanned_at: crate::now_millis(),
    }
}

const SIZE_CACHE_TTL: Duration = Duration::from_secs(600);
const SIZE_PARTIAL_TTL: Duration = Duration::from_secs(60);
const SIZE_WORKERS: usize = 4;
const SIZE_REQUEST_BUDGET: Duration = Duration::from_secs(6);
const SIZE_APP_BUDGET: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSizeInfo {
    pub size: u64,
    pub partial: bool,
    pub measured: bool,
}

struct SizeEntry {
    at: Instant,
    size: u64,
    partial: bool,
}

fn size_cache() -> &'static Mutex<HashMap<String, SizeEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SizeEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn size_key(path: &str) -> String {
    path.trim_end_matches(|character: char| character == '\\' || character == '/')
        .to_ascii_lowercase()
}

fn cached_size(path: &str) -> Option<(u64, bool)> {
    let cache = size_cache().lock().ok()?;
    let entry = cache.get(&size_key(path))?;
    let ttl = if entry.partial {
        SIZE_PARTIAL_TTL
    } else {
        SIZE_CACHE_TTL
    };
    (entry.at.elapsed() < ttl).then_some((entry.size, entry.partial))
}

fn attach_cached_size(app: &mut InstalledApp) {
    app.size = app.estimated_size;
    app.size_partial = false;
    app.size_measured = false;
    let Some(path) = install_path_for_size(app) else {
        return;
    };
    if let Some((size, partial)) = cached_size(&path) {
        app.size = size;
        app.size_partial = partial;
        app.size_measured = true;
    }
}

/// The recorded install folder when it exists, otherwise the usual per-user and
/// machine-wide folders an installer would have used.
fn install_path_for_size(app: &InstalledApp) -> Option<String> {
    let recorded = trim_path(&app.install_location);
    if !recorded.is_empty() && Path::new(&recorded).exists() {
        return Some(recorded);
    }

    let variants: Vec<String> = variants(&app.name)
        .into_iter()
        .filter(|value| is_specific_variant(value))
        .take(2)
        .collect();
    if variants.is_empty() {
        return None;
    }

    let roots = [
        env_path("ProgramFiles"),
        env_path("ProgramFiles(x86)"),
        env_path("LOCALAPPDATA").map(|root| join(&root, "Programs")),
        env_path("LOCALAPPDATA"),
        env_path("APPDATA"),
    ];
    for root in roots.into_iter().flatten() {
        for variant in &variants {
            let candidate = join(&root, variant);
            if Path::new(&candidate).is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

fn measure_install_path(path: &str, deadline: Instant) -> Option<(u64, bool)> {
    // Follow junctions/symlinks at the root: Office and some Store-adjacent
    // installs register a reparse point as their InstallLocation.
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.is_file() {
        return Some((metadata.len(), false));
    }
    if !metadata.is_dir() {
        return None;
    }
    let (size, _files, partial) = measure_dir(path, deadline);
    Some((size, partial))
}

/// Measures the install folders of the given apps. Results are cached for ten
/// minutes (one minute for partial walks) so opening the page again is instant.
pub fn measure_sizes(ids: &[String]) -> HashMap<String, AppSizeInfo> {
    let mut out: HashMap<String, AppSizeInfo> = HashMap::new();
    let mut pending: Vec<(String, String, u64)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for id in ids.iter().take(200) {
        if !seen.insert(id.to_ascii_lowercase()) {
            continue;
        }
        let Ok(app) = find_app(id) else {
            continue;
        };
        let Some(path) = install_path_for_size(&app) else {
            out.insert(
                id.clone(),
                AppSizeInfo {
                    size: app.estimated_size,
                    partial: false,
                    measured: false,
                },
            );
            continue;
        };
        if let Some((size, partial)) = cached_size(&path) {
            out.insert(
                id.clone(),
                AppSizeInfo {
                    size,
                    partial,
                    measured: true,
                },
            );
            continue;
        }
        pending.push((id.clone(), path, app.estimated_size));
    }

    if pending.is_empty() {
        return out;
    }

    let slots: Vec<Mutex<Option<(u64, bool)>>> =
        pending.iter().map(|_| Mutex::new(None)).collect();
    let cursor = AtomicUsize::new(0);
    let deadline = Instant::now() + SIZE_REQUEST_BUDGET;

    std::thread::scope(|scope| {
        for _ in 0..SIZE_WORKERS.min(pending.len()) {
            scope.spawn(|| loop {
                if Instant::now() > deadline {
                    break;
                }
                let index = cursor.fetch_add(1, Ordering::Relaxed);
                let Some((_, path, _)) = pending.get(index) else {
                    break;
                };
                let app_deadline = deadline.min(Instant::now() + SIZE_APP_BUDGET);
                let value = measure_install_path(path, app_deadline);
                if let Ok(mut slot) = slots[index].lock() {
                    *slot = value;
                }
            });
        }
    });

    if let Ok(mut cache) = size_cache().lock() {
        for (index, (id, path, estimated)) in pending.iter().enumerate() {
            let value = slots[index].lock().ok().and_then(|slot| *slot);
            match value {
                Some((size, partial)) => {
                    cache.insert(
                        size_key(path),
                        SizeEntry {
                            at: Instant::now(),
                            size,
                            partial,
                        },
                    );
                    out.insert(
                        id.clone(),
                        AppSizeInfo {
                            size,
                            partial,
                            measured: true,
                        },
                    );
                }
                None => {
                    out.insert(
                        id.clone(),
                        AppSizeInfo {
                            size: *estimated,
                            partial: true,
                            measured: false,
                        },
                    );
                }
            }
        }
    }

    out
}

/// Starts the program's own uninstaller and returns its process id so the UI
/// can wait for it and refresh when it exits.
pub fn launch(id: &str, quiet: bool) -> Result<Option<u32>> {
    let app = find_app(id)?;
    // The wizard usually removes its own uninstall key before it finishes, so
    // keep the details around for the leftover scan that follows.
    remember(&app);
    let raw = if quiet && !app.quiet_uninstall_string.trim().is_empty() {
        app.quiet_uninstall_string
    } else {
        app.uninstall_string
    };
    if raw.trim().is_empty() {
        return Err(CoreError::bad_request(
            "NO_UNINSTALLER",
            "这个程序没有提供卸载命令，可以直接清理它的安装目录",
        ));
    }

    let expanded = expand_env(raw.trim());
    let (program, arguments) = split_command(&expanded);
    if program.trim().is_empty() {
        return Err(CoreError::bad_request(
            "NO_UNINSTALLER",
            "无法解析卸载命令",
        ));
    }
    let arguments = normalize_msiexec(&program, &arguments);

    let verb = to_wide("open");
    let program_w = to_wide(&program);
    let arguments_w = to_wide(&arguments);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(program_w.as_ptr()),
        lpParameters: PCWSTR(arguments_w.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info) }.map_err(|error| {
        CoreError::internal(format!(
            "无法启动卸载程序，它可能已被删除，或需要以管理员身份运行（{error}）"
        ))
    })?;

    if info.hProcess.is_invalid() {
        return Ok(None);
    }
    let pid = unsafe { GetProcessId(info.hProcess) };
    unsafe {
        let _ = CloseHandle(info.hProcess);
    }
    Ok((pid != 0).then_some(pid))
}

/// Whether a process id is still running. Used by the UI to wait for the
/// uninstaller to exit before it rescans and refreshes the list.
/// `None` means the process exists but this user cannot query it (for example
/// an installer that relaunched itself elevated).
pub fn process_state(pid: u32) -> Option<bool> {
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => {
                let mut code = 0u32;
                let alive = GetExitCodeProcess(handle, &mut code).is_ok()
                    && code == STILL_ACTIVE.0 as u32;
                let _ = CloseHandle(handle);
                Some(alive)
            }
            Err(_) => {
                // 87 = the pid no longer exists; anything else (usually 5) means
                // the process is alive but out of our reach.
                if GetLastError() == ERROR_INVALID_PARAMETER {
                    Some(false)
                } else {
                    None
                }
            }
        }
    }
}

pub fn process_running(pid: u32) -> bool {
    process_state(pid).unwrap_or(false)
}

/// Registry keys, folders and shortcuts one uninstall may have left behind.
pub fn leftovers(id: &str) -> Result<LeftoverReport> {
    let app = find_app(id)?;
    let foreign = foreign_locations(&app);
    let candidates = build_candidates(&app, true, &foreign);
    let total = candidates
        .iter()
        .fold(0u64, |sum, candidate| sum.saturating_add(candidate.item.size));

    Ok(LeftoverReport {
        app,
        items: candidates
            .into_iter()
            .map(|candidate| candidate.item)
            .collect(),
        total,
        elevated: elevated(),
        scanned_at: crate::now_millis(),
    })
}

/// Deletes the selected leftovers. Ids are matched against a fresh scan, so a
/// caller cannot smuggle in an arbitrary key or path.
pub fn clean(id: &str, registry: &[String], paths: &[String]) -> Result<CleanReport> {
    let registry_ids: HashSet<String> = registry
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect();
    let path_ids: HashSet<String> = paths
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect();
    if registry_ids.is_empty() && path_ids.is_empty() {
        return Err(CoreError::bad_request(
            "INVALID_TARGET",
            "请选择要删除的残留项",
        ));
    }

    let app = find_app(id)?;
    let foreign = foreign_locations(&app);
    let Some((app_hive, uninstall_path)) = parse_app_id(&app.id) else {
        return Err(CoreError::bad_request("INVALID_APP", "应用标识无效"));
    };

    let mut items: Vec<CleanItem> = Vec::new();
    let mut freed = 0u64;
    let mut deleted = 0u64;
    let mut failed = 0u64;

    // The uninstall key is removed last, and only when everything else worked:
    // keeping it lets the user retry after fixing a permission problem.
    let mut uninstall_entry: Option<Candidate> = None;
    let mut others: Vec<Candidate> = Vec::new();
    for candidate in build_candidates(&app, false, &foreign) {
        let is_uninstall_key = matches!(
            &candidate.target,
            Target::Registry(hive, path)
                if *hive == app_hive && path.eq_ignore_ascii_case(&uninstall_path)
        );
        if is_uninstall_key {
            if registry_ids.contains(&candidate.item.id) {
                uninstall_entry = Some(candidate);
            }
        } else {
            others.push(candidate);
        }
    }

    for candidate in others {
        let wanted = match &candidate.target {
            Target::Registry(..) => registry_ids.contains(&candidate.item.id),
            Target::Path(..) => path_ids.contains(&candidate.item.id),
        };
        if !wanted {
            continue;
        }
        let item = clean_candidate(candidate);
        freed = freed.saturating_add(item.freed);
        deleted += item.deleted;
        if !item.ok {
            failed += 1;
        }
        items.push(item);
    }

    if failed == 0 {
        if let Some(candidate) = uninstall_entry {
            let item = clean_candidate(candidate);
            freed = freed.saturating_add(item.freed);
            deleted += item.deleted;
            if !item.ok {
                failed += 1;
            }
            items.push(item);
        }
    }

    Ok(CleanReport {
        freed,
        deleted,
        failed,
        items,
    })
}

fn clean_candidate(candidate: Candidate) -> CleanItem {
    let mut item = CleanItem {
        id: candidate.item.id.clone(),
        label: candidate.item.label.clone(),
        ok: true,
        freed: 0,
        deleted: 0,
        error: None,
    };

    match candidate.target {
        Target::Registry(hive, key_path) => {
            if let Err(error) = delete_registry(hive, &key_path) {
                item.ok = false;
                item.error = Some(error);
            }
        }
        Target::Path(path) => {
            if let Err(error) = crate::paths::assert_safe_to_delete(&path) {
                item.ok = false;
                item.error = Some(error.message);
            } else {
                let (bytes, count, errors) = crate::cleanup::delete_path(&path);
                item.freed = bytes;
                item.deleted = count;
                if !errors.is_empty() {
                    item.ok = false;
                    item.error = Some(errors.join("；"));
                }
            }
        }
    }

    item
}

pub fn elevated() -> bool {
    unsafe { IsUserAnAdmin().as_bool() }
}

fn uninstall_roots() -> Vec<(Hive, &'static str)> {
    vec![
        (
            Hive::Machine,
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            Hive::Machine,
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            Hive::User,
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
        (
            Hive::User,
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ),
    ]
}

fn find_app(id: &str) -> Result<InstalledApp> {
    let (hive, path) = parse_app_id(id)
        .ok_or_else(|| CoreError::bad_request("INVALID_APP", "应用标识无效"))?;
    if let Some(app) = read_app(hive, &path) {
        return Ok(app);
    }
    // After the official uninstaller removed the key this still lets the user
    // clean what the wizard left behind.
    recall(id).ok_or_else(|| CoreError::not_found("这个程序已经不在已安装列表里了，请重新读取列表"))
}

fn snapshots() -> &'static Mutex<Vec<InstalledApp>> {
    static CACHE: OnceLock<Mutex<Vec<InstalledApp>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn remember(app: &InstalledApp) {
    if let Ok(mut cache) = snapshots().lock() {
        cache.retain(|item| !item.id.eq_ignore_ascii_case(&app.id));
        cache.insert(0, app.clone());
        cache.truncate(16);
    }
}

fn recall(id: &str) -> Option<InstalledApp> {
    snapshots()
        .lock()
        .ok()?
        .iter()
        .find(|item| item.id.eq_ignore_ascii_case(id))
        .cloned()
}

fn parse_app_id(id: &str) -> Option<(Hive, String)> {
    let (hive, path) = id.split_once('|')?;
    let hive = Hive::from_id(hive)?;
    let lower = path.to_ascii_lowercase();
    let inside = lower.starts_with("software\\microsoft\\windows\\currentversion\\uninstall\\")
        || lower.starts_with("software\\wow6432node\\microsoft\\windows\\currentversion\\uninstall\\");
    inside.then(|| (hive, path.to_string()))
}

fn read_app(hive: Hive, key_path: &str) -> Option<InstalledApp> {
    let key = open_key(hive, key_path)?;
    let app = read_values(hive, key_path, key);
    close_key(key);
    app
}

fn read_values(hive: Hive, key_path: &str, key: HKEY) -> Option<InstalledApp> {
    let name = read_string(key, "DisplayName")?;
    if read_u32(key, "SystemComponent") == Some(1)
        || read_u32(key, "NoRemove") == Some(1)
        || read_string(key, "ParentKeyName").is_some()
    {
        return None;
    }
    if let Some(kind) = read_string(key, "ReleaseType") {
        let lower = kind.to_ascii_lowercase();
        if lower.contains("update") || lower.contains("hotfix") || lower.contains("security") {
            return None;
        }
    }

    let uninstall_string = read_string(key, "UninstallString").unwrap_or_default();
    let quiet_uninstall_string =
        read_string(key, "QuietUninstallString").unwrap_or_default();
    let mut install_location = read_string(key, "InstallLocation")
        .map(|value| clean_path(&value))
        .unwrap_or_default();
    if install_location.is_empty() {
        install_location = derived_location(&uninstall_string);
    }

    let estimated_size = read_u32(key, "EstimatedSize")
        .map(|kb| (kb as u64).saturating_mul(1024))
        .unwrap_or(0);

    Some(InstalledApp {
        id: format!("{}|{}", hive.id(), key_path),
        name,
        version: read_string(key, "DisplayVersion").unwrap_or_default(),
        publisher: read_string(key, "Publisher").unwrap_or_default(),
        install_location,
        uninstall_string,
        quiet_uninstall_string,
        estimated_size,
        size: estimated_size,
        size_partial: false,
        size_measured: false,
        icon_path: read_string(key, "DisplayIcon")
            .map(|value| icon_path(&value))
            .unwrap_or_default(),
        install_date: read_string(key, "InstallDate")
            .map(|value| format_install_date(&value))
            .unwrap_or_default(),
        scope: hive.scope(),
    })
}

fn build_candidates(app: &InstalledApp, measure: bool, foreign: &[String]) -> Vec<Candidate> {
    let Some((hive, uninstall_path)) = parse_app_id(&app.id) else {
        return Vec::new();
    };

    let deadline = Instant::now() + MEASURE_BUDGET;
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut add_registry = |target_hive: Hive, path: String| {
        let item_id = format!("reg|{}|{}", target_hive.id(), path.to_ascii_lowercase());
        if !seen.insert(item_id.clone()) {
            return;
        }
        candidates.push(Candidate {
            item: LeftoverItem {
                id: item_id,
                kind: "registry",
                label: if target_hive == hive && path.eq_ignore_ascii_case(&uninstall_path) {
                    "卸载注册信息".to_string()
                } else {
                    "应用注册表项".to_string()
                },
                detail: path.clone(),
                size: 0,
                files: 0,
                needs_admin: target_hive == Hive::Machine,
                partial: false,
                risk: "safe",
            },
            target: Target::Registry(target_hive, path),
        });
    };

    if key_exists(hive, &uninstall_path) {
        add_registry(hive, uninstall_path.clone());
    }

    let variants: Vec<String> = variants(&app.name)
        .into_iter()
        .filter(|value| is_specific_variant(value))
        .take(8)
        .collect();
    let publishers = publisher_aliases(&app.publisher);

    let mut registry_paths: Vec<(Hive, String)> = Vec::new();
    for target_hive in [Hive::Machine, Hive::User] {
        for base in ["SOFTWARE", "SOFTWARE\\WOW6432Node"] {
            for variant in &variants {
                for publisher in &publishers {
                    registry_paths.push((
                        target_hive,
                        format!("{base}\\{publisher}\\{variant}"),
                    ));
                    if let Some(short) = strip_prefix_ci(variant, publisher) {
                        registry_paths.push((
                            target_hive,
                            format!("{base}\\{publisher}\\{short}"),
                        ));
                    }
                }
                registry_paths.push((target_hive, format!("{base}\\{variant}")));
            }
        }
    }
    for (target_hive, path) in registry_paths {
        if key_exists(target_hive, &path) {
            add_registry(target_hive, path);
        }
    }
    drop(add_registry);

    for path in file_candidates(app) {
        let item_id = format!("path|{}", path.to_ascii_lowercase());
        if !seen.insert(item_id.clone()) {
            continue;
        }
        let is_dir = Path::new(&path).is_dir();
        let (size, files, partial) = if !measure {
            (0, 0, false)
        } else if is_dir {
            measure_dir(&path, deadline)
        } else {
            (
                std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
                1,
                false,
            )
        };

        candidates.push(Candidate {
            item: LeftoverItem {
                id: item_id,
                kind: if is_dir { "directory" } else { "file" },
                label: if is_dir {
                    format!("文件夹 · {}", leaf_name(&path))
                } else {
                    format!("快捷方式 · {}", leaf_name(&path))
                },
                detail: path.clone(),
                size,
                files,
                needs_admin: path_needs_admin(&path),
                partial,
                risk: if is_shared_path(&path, foreign) {
                    "caution"
                } else {
                    "safe"
                },
            },
            target: Target::Path(path),
        });
    }

    candidates
}

fn file_candidates(app: &InstalledApp) -> Vec<String> {
    let variants: Vec<String> = variants(&app.name)
        .into_iter()
        .filter(|value| is_specific_variant(value))
        .take(8)
        .collect();
    if variants.is_empty() {
        return accept_paths(
            (!app.install_location.is_empty())
                .then(|| app.install_location.clone())
                .into_iter()
                .collect(),
        );
    }
    let publishers = publisher_aliases(&app.publisher);
    let mut raw: Vec<String> = Vec::new();

    if !app.install_location.is_empty() {
        raw.push(app.install_location.clone());
    }

    let program_files = env_path("ProgramFiles");
    let program_files_x86 = env_path("ProgramFiles(x86)");
    let local = env_path("LOCALAPPDATA");
    let roaming = env_path("APPDATA");
    let program_data = env_path("ProgramData");

    for root in [
        program_files.clone(),
        program_files_x86,
        local.clone(),
        roaming,
        program_data.clone(),
    ]
    .into_iter()
    .flatten()
    {
        for variant in &variants {
            raw.push(join(&root, variant));
            for publisher in &publishers {
                raw.push(join(&root, &join(publisher, variant)));
                if let Some(short) = strip_prefix_ci(variant, publisher) {
                    raw.push(join(&root, &join(publisher, &short)));
                }
            }
        }
    }

    // Squirrel/Electron installers put per-user programs here.
    if let Some(local) = &local {
        for variant in &variants {
            raw.push(join(local, &join("Programs", variant)));
        }
    }

    for root in [
        program_data.map(|root| join(&root, "Microsoft\\Windows\\Start Menu\\Programs")),
        env_path("APPDATA").map(|root| join(&root, "Microsoft\\Windows\\Start Menu\\Programs")),
    ]
    .into_iter()
    .flatten()
    {
        for variant in &variants {
            raw.push(join(&root, variant));
            raw.push(join(&root, &format!("{variant}.lnk")));
        }
    }

    for root in [
        env_path("USERPROFILE").map(|root| join(&root, "Desktop")),
        env_path("PUBLIC").map(|root| join(&root, "Desktop")),
    ]
    .into_iter()
    .flatten()
    {
        for variant in &variants {
            raw.push(join(&root, &format!("{variant}.lnk")));
        }
    }

    accept_paths(raw)
}

fn accept_paths(raw: Vec<String>) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for value in raw {
        let path = trim_path(&value);
        if path.is_empty() || !is_safe_leftover_path(&path) || !Path::new(&path).exists() {
            continue;
        }
        if seen.insert(path.to_ascii_lowercase()) {
            candidates.push(path);
        }
    }

    // Many installers report `...\Chrome\Application` while a sibling candidate
    // is `...\Chrome`. Keep only the shallowest entry so the sizes do not count
    // the same files twice and one delete covers the whole folder.
    let mut accepted: Vec<String> = Vec::new();
    for path in &candidates {
        let lower = path.to_ascii_lowercase();
        let covered = candidates.iter().any(|other| {
            let other = other.to_ascii_lowercase();
            other != lower && lower.starts_with(&format!("{other}\\"))
        });
        if covered {
            continue;
        }
        accepted.push(path.clone());
        if accepted.len() >= MAX_PATH_CANDIDATES {
            break;
        }
    }

    accepted
}

/// Refuses drive roots, system folders and user-profile roots even if an app's
/// own metadata points at them.
fn is_safe_leftover_path(path: &str) -> bool {
    let lower = path
        .trim_end_matches(|character: char| character == '\\' || character == '/')
        .to_ascii_lowercase();
    let bytes = lower.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return false;
    }
    let rest = &lower[3..];
    if rest.is_empty() {
        return false;
    }

    const PROTECTED: &[&str] = &[
        "windows",
        "program files",
        "program files (x86)",
        "programdata",
        "users",
        "users\\public",
        "users\\default",
        "$recycle.bin",
        "system volume information",
        "recovery",
        "perflogs",
    ];
    if PROTECTED.contains(&rest) {
        return false;
    }

    let roots: Vec<String> = [
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
        "PUBLIC",
    ]
    .iter()
    .filter_map(|key| env_path(key))
    .map(|root| trim_path(&root).to_ascii_lowercase())
    .collect();
    if roots.iter().any(|root| lower == *root) {
        return false;
    }

    if let Some(windir) = env_path("WINDIR").map(|root| trim_path(&root).to_ascii_lowercase()) {
        if lower.starts_with(&format!("{windir}\\")) {
            return false;
        }
    }

    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = env_path(key).map(|root| trim_path(&root).to_ascii_lowercase()) else {
            continue;
        };
        for child in [
            "common files",
            "internet explorer",
            "windowsapps",
            "windows defender",
            "windows nt",
            "microsoft",
        ] {
            if lower == format!("{root}\\{child}") {
                return false;
            }
        }
    }

    if let Some(local) = env_path("LOCALAPPDATA").map(|root| trim_path(&root).to_ascii_lowercase()) {
        for child in ["programs", "microsoft", "packages", "temp"] {
            if lower == format!("{local}\\{child}") {
                return false;
            }
        }
    }
    if let Some(roaming) = env_path("APPDATA").map(|root| trim_path(&root).to_ascii_lowercase()) {
        for child in ["microsoft", "microsoft\\windows"] {
            if lower == format!("{roaming}\\{child}") {
                return false;
            }
        }
    }
    if let Some(data) = env_path("ProgramData").map(|root| trim_path(&root).to_ascii_lowercase()) {
        if lower == format!("{data}\\microsoft") {
            return false;
        }
    }
    if let Some(profile) = env_path("USERPROFILE").map(|root| trim_path(&root).to_ascii_lowercase()) {
        for child in [
            "desktop",
            "documents",
            "downloads",
            "pictures",
            "music",
            "videos",
            "appdata",
            "appdata\\local",
            "appdata\\roaming",
            "appdata\\locallow",
            "onedrive",
        ] {
            if lower == format!("{profile}\\{child}") {
                return false;
            }
        }
    }

    true
}

fn path_needs_admin(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    ["ProgramFiles", "ProgramFiles(x86)", "ProgramData"]
        .iter()
        .filter_map(|key| env_path(key))
        .any(|root| lower.starts_with(&root.to_ascii_lowercase()))
}

/// Install locations owned by other programs. A folder that contains one of
/// them, is inside one, or is the same folder is shared with another install,
/// so the UI leaves it unchecked by default.
fn foreign_locations(app: &InstalledApp) -> Vec<String> {
    list(false)
        .items
        .into_iter()
        .filter(|other| {
            !other.id.eq_ignore_ascii_case(&app.id)
                && !other.name.eq_ignore_ascii_case(&app.name)
                && !other.install_location.is_empty()
        })
        .map(|other| other.install_location)
        .collect()
}

fn is_shared_path(path: &str, foreign: &[String]) -> bool {
    let lower = path
        .trim_end_matches(|character: char| character == '\\' || character == '/')
        .to_ascii_lowercase();
    foreign.iter().any(|other| {
        let other = other
            .trim_end_matches(|character: char| character == '\\' || character == '/')
            .to_ascii_lowercase();
        !other.is_empty()
            && (other == lower
                || lower.starts_with(&format!("{other}\\"))
                || other.starts_with(&format!("{lower}\\")))
    })
}

fn measure_dir(path: &str, deadline: Instant) -> (u64, u64, bool) {
    let mut size = 0u64;
    let mut files = 0u64;
    let mut partial = false;
    walk(path, deadline, &mut size, &mut files, &mut partial);
    (size, files, partial)
}

fn walk(directory: &str, deadline: Instant, size: &mut u64, files: &mut u64, partial: &mut bool) {
    if Instant::now() > deadline {
        *partial = true;
        return;
    }
    let Ok(items) = entry::enumerate(directory) else {
        return;
    };
    for item in items {
        if item.is_link() {
            continue;
        }
        if item.is_dir() {
            *files += 1;
            walk(
                &join(directory, &item.name),
                deadline,
                size,
                files,
                partial,
            );
        } else {
            *size = size.saturating_add(item.size);
            *files += 1;
        }
    }
}

fn delete_registry(hive: Hive, path: &str) -> std::result::Result<(), String> {
    let wide = to_wide(path);
    let status = unsafe { RegDeleteTreeW(hive.root(), PCWSTR(wide.as_ptr())) };
    // ERROR_FILE_NOT_FOUND simply means the key is already gone.
    if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
        return Err(registry_error(status.0));
    }
    // RegDeleteTree removes the values and children; this makes sure the key
    // itself is gone too.
    let status = unsafe { RegDeleteKeyW(hive.root(), PCWSTR(wide.as_ptr())) };
    if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
        return Err(registry_error(status.0));
    }
    Ok(())
}

fn registry_error(code: u32) -> String {
    if code == 5 {
        "拒绝访问，需要以管理员身份运行".to_string()
    } else {
        format!("注册表删除失败（错误码 {code}）")
    }
}

fn open_key(hive: Hive, path: &str) -> Option<HKEY> {
    let wide = to_wide(path);
    let mut key = HKEY::default();
    let status = unsafe {
        RegOpenKeyExW(
            hive.root(),
            PCWSTR(wide.as_ptr()),
            None,
            KEY_READ | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    (status == ERROR_SUCCESS && !key.is_invalid()).then_some(key)
}

fn key_exists(hive: Hive, path: &str) -> bool {
    match open_key(hive, path) {
        Some(key) => {
            close_key(key);
            true
        }
        None => false,
    }
}

fn close_key(key: HKEY) {
    unsafe {
        let _ = RegCloseKey(key);
    }
}

fn subkeys(key: HKEY) -> Vec<String> {
    let mut names = Vec::new();
    let mut index = 0u32;
    loop {
        let mut buffer = [0u16; 512];
        let mut length = buffer.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(buffer.as_mut_ptr())),
                &mut length,
                None,
                None,
                None,
                None,
            )
        };
        if status == ERROR_NO_MORE_ITEMS || status != ERROR_SUCCESS {
            break;
        }
        names.push(String::from_utf16_lossy(&buffer[..length as usize]));
        index += 1;
    }
    names
}

fn read_raw(key: HKEY, name: Option<&str>) -> Option<(REG_VALUE_TYPE, Vec<u8>)> {
    let wide = name.map(to_wide);
    let pointer = wide
        .as_ref()
        .map(|value| PCWSTR(value.as_ptr()))
        .unwrap_or(PCWSTR::null());

    let mut kind = REG_VALUE_TYPE(0);
    let mut size = 0u32;
    let status =
        unsafe { RegQueryValueExW(key, pointer, None, Some(&mut kind), None, Some(&mut size)) };
    if status != ERROR_SUCCESS || size == 0 || size > 8 * 1024 * 1024 {
        return None;
    }

    let mut buffer = vec![0u8; size as usize];
    let status = unsafe {
        RegQueryValueExW(
            key,
            pointer,
            None,
            Some(&mut kind),
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    buffer.truncate(size as usize);
    Some((kind, buffer))
}

fn read_string(key: HKEY, name: &str) -> Option<String> {
    let (kind, bytes) = read_raw(key, Some(name))?;
    if kind != REG_SZ && kind != REG_EXPAND_SZ {
        return None;
    }
    let decode = || {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let end = units.iter().position(|value| *value == 0).unwrap_or(units.len());
        String::from_utf16_lossy(&units[..end]).trim().to_string()
    };
    let value = if kind == REG_EXPAND_SZ {
        expand_env(&decode())
    } else {
        decode()
    };
    (!value.is_empty()).then_some(value)
}

fn read_u32(key: HKEY, name: &str) -> Option<u32> {
    let (kind, bytes) = read_raw(key, Some(name))?;
    if kind == REG_DWORD && bytes.len() >= 4 {
        return Some(u32::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3],
        ]));
    }
    if kind == REG_SZ || kind == REG_EXPAND_SZ {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let end = units.iter().position(|value| *value == 0).unwrap_or(units.len());
        return String::from_utf16_lossy(&units[..end]).trim().parse().ok();
    }
    None
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn env_path(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn expand_env(value: &str) -> String {
    if !value.contains('%') {
        return value.to_string();
    }
    let source = to_wide(value);
    unsafe {
        let needed = ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), None);
        if needed == 0 || needed > 32768 {
            return value.to_string();
        }
        let mut buffer = vec![0u16; needed as usize];
        let written = ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), Some(&mut buffer));
        if written == 0 || written > buffer.len() as u32 {
            return value.to_string();
        }
        String::from_utf16_lossy(&buffer[..(written as usize).saturating_sub(1)])
    }
}

fn clean_path(value: &str) -> String {
    trim_path(&expand_env(value))
}

fn trim_path(value: &str) -> String {
    let mut path = value.trim().trim_matches('"').trim().to_string();
    while path.len() > 3 && (path.ends_with('\\') || path.ends_with('/')) {
        path.pop();
    }
    path
}

fn leaf_name(path: &str) -> String {
    path.trim_end_matches(|character: char| character == '\\' || character == '/')
        .rsplit(|character| character == '\\' || character == '/')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn format_install_date(value: &str) -> String {
    let digits: String = value.chars().filter(|character| character.is_ascii_digit()).collect();
    if digits.len() == 8 {
        return format!("{}-{}-{}", &digits[0..4], &digits[4..6], &digits[6..8]);
    }
    value.trim().to_string()
}

fn icon_path(value: &str) -> String {
    let trimmed = value.trim();
    let without_index = match trimmed.rsplit_once(',') {
        Some((head, index)) if !index.trim().is_empty()
            && index.trim().chars().all(|character| character.is_ascii_digit() || character == '-') =>
        {
            head
        }
        _ => trimmed,
    };
    let path = expand_env(without_index.trim().trim_matches('"'));
    if Path::new(&path).is_file() {
        path
    } else {
        String::new()
    }
}

fn derived_location(uninstall: &str) -> String {
    if uninstall.trim().is_empty() {
        return String::new();
    }
    let (program, _) = split_command(&expand_env(uninstall.trim()));
    if is_msiexec(&program) {
        return String::new();
    }
    let path = Path::new(&program);
    if !path.is_absolute() {
        return String::new();
    }
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| {
            parent
                .to_string_lossy()
                .trim_end_matches(|character: char| character == '\\' || character == '/')
                .to_string()
        })
        .unwrap_or_default()
}

fn is_msiexec(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with("msiexec.exe") || lower == "msiexec"
}

fn normalize_msiexec(program: &str, arguments: &str) -> String {
    if !is_msiexec(program) {
        return arguments.to_string();
    }
    // `/I{ProductCode}` opens maintenance mode; `/X{ProductCode}` uninstalls.
    let trimmed = arguments.trim_start();
    if trimmed.len() > 2 {
        let head = &trimmed[..2].to_ascii_lowercase();
        if head == "/i" {
            return format!("/X{}", &trimmed[2..]);
        }
    }
    arguments.to_string()
}

fn split_command(raw: &str) -> (String, String) {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return (
                rest[..end].to_string(),
                rest[end + 1..].trim().to_string(),
            );
        }
        return (rest.trim().to_string(), String::new());
    }

    // Unquoted paths with spaces and no arguments.
    if Path::new(trimmed).is_file() {
        return (trimmed.to_string(), String::new());
    }

    // Longest prefix that is an existing executable, so `C:\Program Files\X\uninstall.exe /S`
    // splits at the right space.
    let mut best: Option<usize> = None;
    for (index, character) in trimmed.char_indices() {
        if character == ' ' && Path::new(&trimmed[..index]).is_file() {
            best = Some(index);
        }
    }
    if let Some(index) = best {
        return (
            trimmed[..index].to_string(),
            trimmed[index + 1..].trim().to_string(),
        );
    }

    match trimmed.find(' ') {
        Some(index) => (
            trimmed[..index].to_string(),
            trimmed[index + 1..].trim().to_string(),
        ),
        None => (trimmed.to_string(), String::new()),
    }
}

fn variants(name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    push_unique(&mut out, name);

    let mut base = name.to_string();
    for _ in 0..2 {
        let Some(index) = base.rfind(" (") else {
            break;
        };
        if !base.trim_end().ends_with(')') {
            break;
        }
        base.truncate(index);
        push_unique(&mut out, &base);
    }

    if let Some(index) = find_version_suffix(&base) {
        push_unique(&mut out, &base[..index]);
    }
    if let Some(index) = base.find(" - ") {
        push_unique(&mut out, &base[..index]);
    }

    out.retain(|value| value.len() <= 80);
    out
}

fn find_version_suffix(value: &str) -> Option<usize> {
    let mut index = value.len();
    while let Some(space) = value[..index].rfind(' ') {
        let token = &value[space + 1..index];
        if token.len() >= 2 {
            let stem = token
                .strip_prefix('v')
                .or_else(|| token.strip_prefix('V'))
                .unwrap_or(token);
            let first = stem.chars().next().unwrap_or(' ');
            let version_like = first.is_ascii_digit()
                && (stem.contains('.')
                    || stem.chars().all(|character| character.is_ascii_digit()));
            if version_like || stem.to_ascii_lowercase().starts_with("version") {
                return Some(space);
            }
        }
        if space == 0 {
            break;
        }
        index = space;
    }
    None
}

fn push_unique(out: &mut Vec<String>, value: &str) {
    let value = value.trim().trim_matches('"').trim();
    let value = value
        .trim_end_matches(|character: char| character == '-' || character == ',' || character == ' ')
        .trim();
    if value.len() < 2 {
        return;
    }
    if out
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(value))
    {
        return;
    }
    out.push(value.to_string());
}

fn is_specific_variant(value: &str) -> bool {
    if value.len() < 3 || value.len() > 80 {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    const GENERIC: &[&str] = &[
        "update",
        "updater",
        "updates",
        "setup",
        "installer",
        "install",
        "uninstall",
        "application",
        "app",
        "program",
        "common",
        "shared",
        "tools",
        "runtime",
        "client",
        "service",
        "driver",
        "drivers",
        "system",
        "software",
        "support",
        "microsoft",
        "windows",
        "google",
        "apple",
        "intel",
        "nvidia",
        "amd",
        "program files",
        "programdata",
        "users",
        "temp",
        "cache",
        "bin",
        "data",
        "resources",
        "locales",
        "plugins",
        "extensions",
        "helper",
        "helpers",
    ];
    !GENERIC.contains(&lower.as_str())
}

fn publisher_aliases(value: &str) -> Vec<String> {
    let raw = value.trim().trim_end_matches(&['.', ' '][..]);
    if raw.is_empty() {
        return Vec::new();
    }

    let mut out: Vec<String> = Vec::new();
    push_unique(&mut out, raw);
    let normalized = normalize_publisher(raw);
    if !normalized.is_empty() {
        push_unique(&mut out, &normalized);
    }

    const BLOCKED: &[&str] = &["microsoft", "microsoft corporation", "windows", "common files"];
    out.retain(|value| {
        value.len() >= 2 && !BLOCKED.iter().any(|blocked| value.eq_ignore_ascii_case(blocked))
    });
    out
}

fn normalize_publisher(value: &str) -> String {
    const SUFFIXES: &[&str] = &[
        "corporation",
        "corp",
        "incorporated",
        "inc",
        "llc",
        "ltd",
        "limited",
        "gmbh",
        "co",
        "s.a.",
        "s.l.",
        "b.v.",
        "a/s",
        "pty ltd",
        "pty",
    ];

    let mut name = value.trim().to_string();
    loop {
        let trimmed = name
            .trim_end_matches(|character: char| character == '.' || character == ',' || character.is_whitespace());
        let lower = trimmed.to_ascii_lowercase();
        let suffix = SUFFIXES.iter().find(|suffix| {
            lower == **suffix
                || lower.ends_with(&format!(" {suffix}"))
                || lower.ends_with(&format!(",{suffix}"))
        });
        let Some(suffix) = suffix else {
            break;
        };
        let cut = trimmed.len().saturating_sub(suffix.len());
        name = trimmed[..cut]
            .trim_end_matches(|character: char| character == ',' || character.is_whitespace())
            .to_string();
        if name.is_empty() {
            return String::new();
        }
    }

    let trimmed = name
        .trim_end_matches(|character: char| character == '.' || character == ',' || character.is_whitespace())
        .trim();
    if trimmed.len() >= 2 {
        trimmed.to_string()
    } else {
        String::new()
    }
}

fn strip_prefix_ci(value: &str, prefix: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let prefix_lower = prefix.to_ascii_lowercase();
    if lower == prefix_lower || !lower.starts_with(&prefix_lower) {
        return None;
    }
    let rest = value
        .get(prefix.len()..)?
        .trim_start_matches(|character: char| character == ' ' || character == '-' || character == ':')
        .trim();
    (rest.len() >= 3 && is_specific_variant(rest)).then(|| rest.to_string())
}
