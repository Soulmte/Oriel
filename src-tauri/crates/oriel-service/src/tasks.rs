//! Background copy/move queue.
//!
//! A transfer returns a task id immediately and streams progress over the
//! event channel. Cancellation and pause are checked between 1 MiB blocks, and
//! an overwrite stages the new tree so a failed copy never destroys the
//! existing entry.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::broadcast;

use oriel_core::entry;
use oriel_core::fsops::{self, Control};
use oriel_core::paths::{self, join};
use oriel_core::CoreError;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub kind: &'static str,
    pub status: &'static str,
    pub total: usize,
    pub done: usize,
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created: Vec<String>,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

pub struct TaskState {
    task: Mutex<Task>,
    cancelled: AtomicBool,
    paused: AtomicBool,
    last_publish: Mutex<Instant>,
}

impl TaskState {
    fn snapshot(&self) -> Task {
        self.task.lock().map(|task| task.clone()).unwrap_or_else(|_| Task {
            id: String::new(),
            kind: "copy",
            status: "failed",
            total: 0,
            done: 0,
            current: None,
            error: Some("任务状态不可用".to_string()),
            created: Vec::new(),
            bytes_done: 0,
            bytes_total: 0,
        })
    }

    fn publish(&self) {
        let task = self.snapshot();
        if !task.id.is_empty() {
            let _ = EVENTS.send(task);
        }
    }

    fn add_bytes(&self, bytes: u64) {
        if let Ok(mut task) = self.task.lock() {
            task.bytes_done = task.bytes_done.saturating_add(bytes);
        }
        let should_publish = self
            .last_publish
            .lock()
            .map(|mut at| {
                if at.elapsed() >= PROGRESS_INTERVAL {
                    *at = Instant::now();
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if should_publish {
            self.publish();
        }
    }

    fn set<F: FnOnce(&mut Task)>(&self, job: F) {
        if let Ok(mut task) = self.task.lock() {
            job(&mut task);
        }
        self.publish();
    }
}

impl Control for TaskState {
    fn check(&self) -> Result<(), CoreError> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(CoreError::new(499, "CANCELLED", "已取消"));
        }
        Ok(())
    }

    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
}

#[derive(Clone)]
struct Request {
    kind: &'static str,
    sources: Vec<String>,
    target: String,
    policy: &'static str,
}

struct Registry {
    tasks: HashMap<String, Arc<TaskState>>,
    requests: HashMap<String, Request>,
    finished: HashSet<String>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| {
    Mutex::new(Registry {
        tasks: HashMap::new(),
        requests: HashMap::new(),
        finished: HashSet::new(),
    })
});

static EVENTS: LazyLock<broadcast::Sender<Task>> = LazyLock::new(|| {
    let (sender, _) = broadcast::channel(256);
    sender
});

pub fn subscribe() -> broadcast::Receiver<Task> {
    EVENTS.subscribe()
}

pub fn get(id: &str) -> Option<Task> {
    let registry = REGISTRY.lock().ok()?;
    registry.tasks.get(id).map(|state| state.snapshot())
}

pub fn cancel(id: &str) -> bool {
    let registry = match REGISTRY.lock() {
        Ok(registry) => registry,
        Err(_) => return false,
    };
    match registry.tasks.get(id) {
        Some(state) => {
            state.cancelled.store(true, Ordering::Relaxed);
            state.paused.store(false, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

pub fn pause(id: &str) -> bool {
    let registry = match REGISTRY.lock() {
        Ok(registry) => registry,
        Err(_) => return false,
    };
    match registry.tasks.get(id) {
        Some(state) => {
            if registry.finished.contains(id) {
                return false;
            }
            state.paused.store(true, Ordering::Relaxed);
            state.set(|task| task.status = "paused");
            true
        }
        None => false,
    }
}

pub fn resume(id: &str) -> bool {
    let registry = match REGISTRY.lock() {
        Ok(registry) => registry,
        Err(_) => return false,
    };
    match registry.tasks.get(id) {
        Some(state) => {
            if registry.finished.contains(id) {
                return false;
            }
            state.paused.store(false, Ordering::Relaxed);
            state.set(|task| task.status = "running");
            true
        }
        None => false,
    }
}

pub fn retry(id: &str) -> Option<Task> {
    let request = {
        let registry = REGISTRY.lock().ok()?;
        registry.requests.get(id).cloned()
    }?;
    Some(create_transfer(
        request.kind,
        request.sources,
        request.target,
        request.policy,
    ))
}

fn new_id() -> String {
    static COUNTER: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(0));
    let count = COUNTER
        .lock()
        .map(|mut value| {
            *value += 1;
            *value
        })
        .unwrap_or(0);
    format!("{:x}-{:x}", oriel_core::now_millis(), count)
}

fn unique_path(directory: &str, name: &str) -> String {
    let ext = match name.rfind('.') {
        Some(index) if index > 0 => name[index..].to_string(),
        _ => String::new(),
    };
    let stem = &name[..name.len() - ext.len()];
    for index in 1..1000 {
        let candidate = join(directory, &format!("{stem} ({index}){ext}"));
        if !entry::exists(&candidate) {
            return candidate;
        }
    }
    join(directory, &format!("{stem} ({}){ext}", oriel_core::now_millis()))
}

fn resolve_destination(source: &str, target: &str, policy: &str) -> Option<String> {
    let name = paths::file_name_of(source);
    let destination = join(target, &name);
    if !entry::exists(&destination) {
        return Some(destination);
    }
    match policy {
        "overwrite" => Some(destination),
        "skip" => None,
        _ => Some(unique_path(target, &name)),
    }
}

fn estimate_bytes(sources: &[String]) -> u64 {
    fn walk(target: &str) -> u64 {
        let stat = match entry::stat(target) {
            Ok(stat) => stat,
            Err(_) => return 0,
        };
        if stat.kind != "directory" {
            return stat.size;
        }
        match entry::enumerate(target) {
            Ok(raw) => raw
                .iter()
                .filter(|item| !item.is_link())
                .map(|item| {
                    if item.is_dir() {
                        walk(&join(target, &item.name))
                    } else {
                        item.size
                    }
                })
                .sum(),
            Err(_) => 0,
        }
    }
    sources.iter().map(|source| walk(source)).sum()
}

fn remove_if_exists(target: &str) {
    if entry::exists(target) {
        let _ = fsops::remove_permanent(target);
    }
}

fn run(kind: &'static str, sources: Vec<String>, target: String, policy: &'static str, state: Arc<TaskState>, id: String) {
    state.set(|task| task.status = "running");

    if kind == "copy" {
        let total = estimate_bytes(&sources);
        state.set(|task| task.bytes_total = total);
    }
    state.set(|task| task.bytes_done = 0);

    let mut created: Vec<String> = Vec::new();

    for source in &sources {
        if let Err(error) = state.check() {
            finish(&state, &id, "cancelled", Some(error.message), &mut created);
            return;
        }
        state.set(|task| {
            task.current = Some(paths::file_name_of(source));
        });

        let destination = match resolve_destination(source, &target, policy) {
            Some(destination) => destination,
            None => {
                state.set(|task| task.done += 1);
                continue;
            }
        };

        let replacing = policy == "overwrite" && entry::exists(&destination);
        let staged = if replacing {
            format!("{destination}.oriel-new")
        } else {
            destination.clone()
        };
        let backup = format!("{destination}.oriel-old");

        if replacing {
            remove_if_exists(&staged);
        }

        let worker = Arc::clone(&state);
        let result = if kind == "copy" {
            fsops::copy_tree(source, &staged, state.as_ref(), &mut |bytes| worker.add_bytes(bytes))
        } else {
            fsops::move_entry(source, &staged, state.as_ref(), &mut |bytes| worker.add_bytes(bytes))
        };

        if let Err(error) = result {
            remove_if_exists(&staged);
            if replacing && entry::exists(&backup) && !entry::exists(&destination) {
                let _ = std::fs::rename(&backup, &destination);
            }
            let status = if error.status == 499 { "cancelled" } else { "failed" };
            finish(&state, &id, status, Some(error.message), &mut created);
            return;
        }

        if replacing {
            remove_if_exists(&backup);
            if std::fs::rename(&destination, &backup).is_err() {
                remove_if_exists(&staged);
                finish(&state, &id, "failed", Some("无法替换原有项目".to_string()), &mut created);
                return;
            }
            if std::fs::rename(&staged, &destination).is_err() {
                let _ = std::fs::rename(&backup, &destination);
                remove_if_exists(&staged);
                finish(&state, &id, "failed", Some("无法写入目标位置".to_string()), &mut created);
                return;
            }
            remove_if_exists(&backup);
        }

        created.push(destination.clone());
        state.set(|task| {
            task.created.push(destination);
            task.done += 1;
        });
    }

    finish(&state, &id, "done", None, &mut created);
}

fn finish(state: &Arc<TaskState>, id: &str, status: &'static str, error: Option<String>, created: &mut Vec<String>) {
    if status == "failed" {
        for item in created.iter() {
            let _ = fsops::remove_permanent(item);
        }
        state.set(|task| task.created.clear());
    }
    state.set(|task| {
        task.status = status;
        task.current = None;
        task.error = error;
    });
    if let Ok(mut registry) = REGISTRY.lock() {
        registry.finished.insert(id.to_string());
    }
}

pub fn create_transfer(kind: &str, sources: Vec<String>, target: String, policy: &str) -> Task {
    let kind: &'static str = if kind == "move" { "move" } else { "copy" };
    let policy: &'static str = match policy {
        "overwrite" => "overwrite",
        "skip" => "skip",
        "keep-both" => "keep-both",
        _ => "rename",
    };
    let id = new_id();

    let task = Task {
        id: id.clone(),
        kind,
        status: "queued",
        total: sources.len(),
        done: 0,
        current: None,
        error: None,
        created: Vec::new(),
        bytes_done: 0,
        bytes_total: 0,
    };

    let state = Arc::new(TaskState {
        task: Mutex::new(task.clone()),
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        last_publish: Mutex::new(Instant::now()),
    });

    if let Ok(mut registry) = REGISTRY.lock() {
        registry.tasks.insert(id.clone(), Arc::clone(&state));
        registry.requests.insert(
            id.clone(),
            Request {
                kind,
                sources: sources.clone(),
                target: target.clone(),
                policy,
            },
        );
    }

    let _ = EVENTS.send(task.clone());

    std::thread::spawn(move || run(kind, sources, target, policy, state, id));

    task
}

pub fn find_conflicts(sources: &[String], target: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for source in sources {
        let destination = join(target, &paths::file_name_of(source));
        if entry::exists(&destination) {
            out.push((source.clone(), destination));
        }
    }
    out
}

/// Downloads an update asset into the temp folder as a tracked task, trying the
/// CDN, the Gitee mirror and GitHub in the order the caller supplied.
pub fn create_download(urls: Vec<String>, name: String) -> Task {
    let id = new_id();
    let destination = std::env::temp_dir().join(sanitize(&name));

    let task = Task {
        id: id.clone(),
        kind: "download",
        status: "queued",
        total: 1,
        done: 0,
        current: Some(name),
        error: None,
        created: Vec::new(),
        bytes_done: 0,
        bytes_total: 0,
    };

    let state = Arc::new(TaskState {
        task: Mutex::new(task.clone()),
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        last_publish: Mutex::new(Instant::now()),
    });

    if let Ok(mut registry) = REGISTRY.lock() {
        registry.tasks.insert(id.clone(), Arc::clone(&state));
    }

    let _ = EVENTS.send(task.clone());
    let target_path = destination.clone();

    std::thread::spawn(move || {
        state.set(|task| task.status = "running");
        let mut last_error = String::new();

        for url in &urls {
            if state.check().is_err() {
                state.set(|task| task.status = "cancelled");
                return;
            }
            match ureq::get(url).timeout(Duration::from_secs(60)).call() {
                Ok(response) => {
                    let total = response
                        .header("Content-Length")
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0);
                    state.set(|task| task.bytes_total = total);

                    let mut file = match std::fs::File::create(&target_path) {
                        Ok(file) => file,
                        Err(error) => {
                            state.set(|task| {
                                task.status = "failed";
                                task.error = Some(error.to_string());
                            });
                            return;
                        }
                    };

                    let mut reader = response.into_reader();
                    let mut buffer = vec![0u8; 1024 * 1024];
                    loop {
                        if state.check().is_err() {
                            state.set(|task| task.status = "cancelled");
                            return;
                        }
                        let read = match std::io::Read::read(&mut reader, &mut buffer) {
                            Ok(read) => read,
                            Err(error) => {
                                last_error = error.to_string();
                                break;
                            }
                        };
                        if read == 0 {
                            let destination = target_path.to_string_lossy().to_string();
                            state.set(|task| {
                                task.status = "done";
                                task.done = 1;
                                task.current = None;
                                task.created.push(destination);
                            });
                            return;
                        }
                        if std::io::Write::write_all(&mut file, &buffer[..read]).is_err() {
                            last_error = "无法写入下载文件".to_string();
                            break;
                        }
                        state.add_bytes(read as u64);
                    }
                }
                Err(error) => last_error = error.to_string(),
            }
        }

        state.set(|task| {
            task.status = "failed";
            task.current = None;
            task.error = Some(if last_error.is_empty() {
                "下载失败".to_string()
            } else {
                format!("下载失败：{last_error}")
            });
        });
    });

    task
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.trim().is_empty() {
        "oriel-update.bin".to_string()
    } else {
        cleaned
    }
}
