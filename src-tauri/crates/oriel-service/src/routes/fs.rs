use std::convert::Infallible;
use std::io::SeekFrom;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::stream::StreamExt;
use notify::Watcher;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use oriel_core::entry::Entry;
use oriel_core::{drives, entry, info, paths, search};

use crate::archive;
use crate::{ApiResult, CoreError};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PathQuery {
    pub path: Option<String>,
    pub show_hidden: Option<String>,
    pub q: Option<String>,
    pub scope: Option<String>,
    pub limit: Option<u32>,
    pub size: Option<u32>,
    pub budget_ms: Option<u64>,
    pub watch: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EntriesBody {
    pub path: Option<String>,
    pub names: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct IconsBody {
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct SizesBody {
    pub paths: Option<Vec<String>>,
}

fn flag(value: Option<&String>) -> bool {
    matches!(value.map(|text| text.as_str()), Some("1") | Some("true"))
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> ApiResult<T> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|error| CoreError::internal(error.to_string()).into())
}

fn target_of(query: &PathQuery) -> ApiResult<String> {
    Ok(paths::normalize_path(query.path.as_deref())?)
}

pub async fn list(Query(query): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let raw = query.path.clone().unwrap_or_default();
    if archive::is_archive_path(raw.trim()) {
        let target = raw.trim().to_string();
        let hidden = flag(query.show_hidden.as_ref());
        let (path, parent, mut entries) =
            blocking(move || archive::list(&target)).await??;
        if !hidden {
            entries.retain(|entry| !entry.hidden);
        }
        return Ok(Json(json!({ "path": path, "parent": parent, "entries": entries })));
    }
    let target = target_of(&query)?;
    let hidden = flag(query.show_hidden.as_ref());
    let (path, parent, entries) = blocking(move || entry::list(&target, hidden)).await??;
    Ok(Json(json!({ "path": path, "parent": parent, "entries": entries })))
}

pub async fn stat(Query(query): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let raw = query.path.clone().unwrap_or_default();
    if archive::is_archive_path(raw.trim()) {
        let target = raw.trim().to_string();
        let value = blocking(move || archive::stat(&target)).await??;
        return Ok(Json(json!(value)));
    }
    let target = target_of(&query)?;
    let value = blocking(move || entry::stat(&target)).await??;
    Ok(Json(json!(value)))
}

pub async fn entries(Json(body): Json<EntriesBody>) -> ApiResult<Json<Value>> {
    let directory = paths::normalize_path(body.path.as_deref())?;
    let names = body.names.unwrap_or_default();
    if names.is_empty() {
        return Ok(Json(json!({ "entries": [] })));
    }
    let list = blocking(move || entry::read_entries_by_name(&directory, &names)).await?;
    Ok(Json(json!({ "entries": list })))
}

pub async fn resolve(Query(query): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let raw = query.path.unwrap_or_default();
    let resolved = paths::resolve_input(&raw)?;
    let exists = entry::exists(&resolved);
    Ok(Json(json!({ "path": resolved, "exists": exists })))
}

pub async fn preview(Query(query): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let raw = query.path.clone().unwrap_or_default();
    if archive::is_archive_path(raw.trim()) {
        let target = raw.trim().to_string();
        let worker = target.clone();
        let (buffer, size) = blocking(move || {
            archive::read_entry(&worker, oriel_core::info::PREVIEW_BYTE_LIMIT)
        })
        .await??;
        let binary = buffer.contains(&0);
        let name = paths::file_name_of(&target);
        let inner = target
            .split('|')
            .nth(1)
            .unwrap_or("")
            .rsplit('\\')
            .next()
            .unwrap_or("")
            .to_string();
        let ext = if inner.contains('.') {
            inner.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
        } else {
            String::new()
        };
        return Ok(Json(json!({
            "path": target,
            "name": if inner.is_empty() { name } else { inner },
            "ext": ext,
            "encoding": if binary { "binary" } else { "utf8" },
            "content": if binary { Value::Null } else { Value::String(String::from_utf8_lossy(&buffer).to_string()) },
            "size": size,
            "truncated": size > buffer.len() as u64,
        })));
    }
    let target = target_of(&query)?;
    let value = blocking(move || info::preview(&target)).await??;
    Ok(Json(json!(value)))
}

pub async fn info(Query(query): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let raw = query.path.clone().unwrap_or_default();
    if archive::is_archive_path(raw.trim()) {
        let target = raw.trim().to_string();
        let value = blocking(move || archive::stat(&target)).await??;
        return Ok(Json(json!({
            "path": value.path,
            "kind": value.kind,
            "size": value.size,
            "mtimeMs": value.mtime_ms,
            "birthtimeMs": value.birthtime_ms,
            "readonly": true,
            "isLink": false,
        })));
    }
    let target = target_of(&query)?;
    let value = blocking(move || info::file_info(&target)).await??;
    Ok(Json(json!(value)))
}

pub async fn size(Query(query): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let target = target_of(&query)?;
    let stat = entry::stat(&target)?;
    if stat.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "该路径不是文件夹").into());
    }
    let value = blocking(move || info::measure_directory(&target)).await?;
    Ok(Json(json!(value)))
}

pub async fn sizes(Json(body): Json<SizesBody>) -> ApiResult<Json<Value>> {
    let candidates: Vec<String> = body.paths.unwrap_or_default().into_iter().take(120).collect();
    let mut results: Vec<(String, info::DirectorySize)> = Vec::new();
    let mut tasks = Vec::new();
    for candidate in candidates {
        tasks.push(tokio::task::spawn_blocking(move || {
            let target = paths::normalize(candidate.as_str()).ok()?;
            let stat = entry::stat(&target).ok()?;
            if stat.kind != "directory" {
                return None;
            }
            Some((target.clone(), info::measure_directory(&target)))
        }));
    }
    for task in tasks {
        if let Ok(Some(pair)) = task.await {
            results.push(pair);
        }
    }
    let map: serde_json::Map<String, Value> = results
        .into_iter()
        .map(|(path, value)| (path, json!(value)))
        .collect();
    Ok(Json(json!({ "sizes": map })))
}

pub async fn icons(Json(body): Json<IconsBody>) -> ApiResult<Json<Value>> {
    let targets = body.paths.unwrap_or_default();
    let mut normalized: Vec<String> = Vec::new();
    for value in targets.into_iter().take(120) {
        if let Ok(path) = paths::normalize(&value) {
            normalized.push(path);
        }
    }
    let map = blocking(move || oriel_core::icons::icons(&normalized)).await?;
    Ok(Json(json!({ "icons": map })))
}

pub async fn search(Query(query): Query<PathQuery>) -> ApiResult<Json<Value>> {
    let target = target_of(&query)?;
    let text = query.q.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Err(CoreError::bad_request("INVALID_QUERY", "请输入至少 1 个字符").into());
    }
    let stat = entry::stat(&target)?;
    if stat.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "搜索起点必须是文件夹").into());
    }

    let options = search::SearchOptions {
        show_hidden: flag(query.show_hidden.as_ref()),
        limit: query.limit.unwrap_or(search::SEARCH_RESULT_LIMIT as u32) as usize,
        budget: Duration::from_millis(query.budget_ms.unwrap_or(10_000)),
    };
    let root = match query.scope.as_deref() {
        Some("disk") => search::disk_root_for(&target),
        _ => target.clone(),
    };
    let query_text = text.clone();
    let summary = blocking(move || search::search(&root, &query_text, options)).await?;
    Ok(Json(json!({
        "path": target,
        "query": text,
        "entries": summary.entries,
        "truncated": summary.truncated,
        "scanned": summary.scanned,
        "timedOut": summary.timed_out,
    })))
}

enum SearchMessage {
    Matches(Vec<Entry>),
    Progress(usize),
    Done {
        path: String,
        query: String,
        scanned: usize,
        total: usize,
        truncated: bool,
        timed_out: bool,
    },
}

struct CancelGuard(Arc<AtomicBool>);

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub async fn search_stream(
    Query(query): Query<PathQuery>,
) -> ApiResult<Response> {
    let target = target_of(&query)?;
    let text = query.q.clone().unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Err(CoreError::bad_request("INVALID_QUERY", "请输入至少 1 个字符").into());
    }
    let stat = entry::stat(&target)?;
    if stat.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "搜索起点必须是文件夹").into());
    }

    let options = search::SearchOptions {
        show_hidden: flag(query.show_hidden.as_ref()),
        limit: query.limit.unwrap_or(search::SEARCH_RESULT_LIMIT as u32) as usize,
        budget: Duration::from_millis(query.budget_ms.unwrap_or(10_000).clamp(500, 120_000)),
    };

    let roots: Vec<String> = match query.scope.as_deref() {
        Some("disk") => vec![search::disk_root_for(&target)],
        Some("all") => drives::list(false)
            .into_iter()
            .map(|drive| drive.path)
            .collect(),
        _ => vec![target.clone()],
    };

    let (sender, receiver) = tokio::sync::mpsc::channel::<SearchMessage>(128);
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_worker = Arc::clone(&cancel);
    let path_for_done = target.clone();
    let query_for_done = text.clone();

    std::thread::spawn(move || {
        let mut total = 0usize;
        let mut scanned = 0usize;
        let mut truncated = false;
        let mut timed_out = false;

        for root in roots {
            if cancel_for_worker.load(Ordering::Relaxed) {
                truncated = true;
                break;
            }
            if total >= options.limit {
                truncated = true;
                break;
            }
            let mut remaining = options.clone();
            remaining.limit = options.limit.saturating_sub(total).max(1);
            let query = query_for_done.clone();
            let sender = sender.clone();
            let summary = search::run_search(
                &root,
                &query,
                remaining,
                Some(Arc::clone(&cancel_for_worker)),
                |event| {
                    let message = match event {
                        search::SearchEvent::Matches(entries) => SearchMessage::Matches(entries),
                        search::SearchEvent::Progress(count) => SearchMessage::Progress(count),
                    };
                    let _ = sender.blocking_send(message);
                },
            );
            total += summary.entries.len();
            scanned += summary.scanned;
            truncated |= summary.truncated;
            timed_out |= summary.timed_out;
        }

        let _ = sender.blocking_send(SearchMessage::Done {
            path: path_for_done,
            query: query_for_done,
            scanned,
            total,
            truncated,
            timed_out,
        });
    });

    let stream = futures_util::stream::unfold(
        (receiver, CancelGuard(cancel)),
        |(mut receiver, guard)| async move {
            receiver.recv().await.map(|message| {
                let event = match message {
                    SearchMessage::Matches(entries) => Event::default()
                        .event("matches")
                        .data(json!({ "entries": entries }).to_string()),
                    SearchMessage::Progress(scanned) => Event::default()
                        .event("progress")
                        .data(json!({ "scanned": scanned }).to_string()),
                    SearchMessage::Done {
                        path,
                        query,
                        scanned,
                        total,
                        truncated,
                        timed_out,
                    } => Event::default().event("done").data(
                        json!({
                            "path": path,
                            "query": query,
                            "scanned": scanned,
                            "total": total,
                            "truncated": truncated,
                            "timedOut": timed_out,
                        })
                        .to_string(),
                    ),
                };
                (Ok::<Event, Infallible>(event), (receiver, guard))
            })
        },
    )
    .boxed();

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}

pub async fn download(Query(query): Query<PathQuery>) -> ApiResult<Response> {
    let raw = query.path.clone().unwrap_or_default();
    if archive::is_archive_path(raw.trim()) {
        let target = raw.trim().to_string();
        let worker = target.clone();
        let (bytes, _) = blocking(move || archive::read_entry(&worker, u64::MAX)).await??;
        let name = target.split('|').nth(1).unwrap_or("").rsplit('\\').next().unwrap_or("download");
        return Response::builder()
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(
                header::CONTENT_DISPOSITION,
                format!("attachment; filename*=UTF-8''{}", percent_encode(name)),
            )
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .body(Body::from(bytes))
            .map_err(|error| CoreError::internal(error.to_string()).into());
    }
    let target = target_of(&query)?;
    let stat = entry::stat(&target)?;
    if stat.kind == "directory" {
        return Err(CoreError::bad_request("NOT_A_FILE", "不能下载文件夹").into());
    }
    file_response(&target, None, false).await
}

pub async fn media(Query(query): Query<PathQuery>, headers: axum::http::HeaderMap) -> ApiResult<Response> {
    let raw = query.path.clone().unwrap_or_default();
    if archive::is_archive_path(raw.trim()) {
        return Err(CoreError::bad_request(
            "ARCHIVE_MEDIA_UNSUPPORTED",
            "归档内的音视频需要先解压才能播放",
        )
        .into());
    }
    let target = target_of(&query)?;
    let stat = entry::stat(&target)?;
    if stat.kind == "directory" {
        return Err(CoreError::bad_request("NOT_A_FILE", "不能预览文件夹").into());
    }
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    file_response(&target, range, true).await
}

async fn file_response(target: &str, range: Option<String>, inline: bool) -> ApiResult<Response> {
    let metadata = tokio::fs::metadata(target)
        .await
        .map_err(CoreError::from)?;
    let total = metadata.len();
    let mime = oriel_core::mime::for_path(target);

    let mut start = 0u64;
    let mut end = total.saturating_sub(1);
    let mut partial = false;

    if let Some(value) = range {
        if let Some(spec) = value.trim().strip_prefix("bytes=") {
            let parts: Vec<&str> = spec.split('-').collect();
            if parts.len() == 2 {
                let first = parts[0].trim().parse::<u64>().ok();
                let second = parts[1].trim().parse::<u64>().ok();
                if let (Some(a), Some(b)) = (first, second) {
                    start = a;
                    end = b.min(total.saturating_sub(1));
                    partial = true;
                } else if let Some(a) = first {
                    start = a;
                    end = total.saturating_sub(1);
                    partial = true;
                }
                if start >= total {
                    return Ok(Response::builder()
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                        .body(Body::empty())
                        .map_err(|error| CoreError::internal(error.to_string()))?);
                }
            }
        }
    }

    let length = if total == 0 { 0 } else { end - start + 1 };
    let mut file = tokio::fs::File::open(target)
        .await
        .map_err(CoreError::from)?;
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(CoreError::from)?;
    }
    let stream = ReaderStream::new(file.take(length));
    let body = Body::from_stream(stream);

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string());

    builder = if inline {
        builder.header(header::CONTENT_DISPOSITION, "inline")
    } else {
        let name = paths::file_name_of(target);
        builder.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename*=UTF-8''{}", percent_encode(&name)),
        )
    };

    if partial {
        builder = builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
    }

    builder
        .body(body)
        .map_err(|error| CoreError::internal(error.to_string()).into())
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let safe = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if safe {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub async fn events(
    Query(query): Query<PathQuery>,
) -> ApiResult<Response> {
    let watch = query
        .watch
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| paths::normalize(value).ok());

    let (sender, receiver) = tokio::sync::mpsc::channel::<String>(64);
    let mut watcher: Option<notify::RecommendedWatcher> = None;

    if let Some(watch_path) = watch {
        let sender = sender.clone();
        let path_for_payload = watch_path.clone();
        let mut created = notify::recommended_watcher(
            move |result: Result<notify::Event, notify::Error>| {
                if let Ok(event) = result {
                    let names: Vec<String> = event
                        .paths
                        .iter()
                        .filter_map(|path| {
                            path.file_name().map(|name| name.to_string_lossy().to_string())
                        })
                        .collect();
                    let payload =
                        json!({ "path": path_for_payload, "names": names }).to_string();
                    let _ = sender.try_send(payload);
                }
            },
        )
        .map_err(|error| CoreError::internal(error.to_string()))?;
        let _ = created.watch(
            std::path::Path::new(&watch_path),
            notify::RecursiveMode::NonRecursive,
        );
        watcher = Some(created);
    }

    let task_receiver = crate::tasks::subscribe();
    let task_stream = futures_util::stream::unfold(task_receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(task) => {
                    let payload = json!(task).to_string();
                    return Some((
                        Ok::<Event, Infallible>(Event::default().event("task").data(payload)),
                        receiver,
                    ));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return None,
            }
        }
    });

    // The sender stays inside the stream state: dropping it would end the
    // channel and close the whole connection.
    let stream = futures_util::stream::unfold(
        (receiver, watcher, sender),
        |(mut receiver, watcher, sender)| async move {
            receiver.recv().await.map(|payload| {
                (
                    Ok::<Event, Infallible>(Event::default().event("fs-change").data(payload)),
                    (receiver, watcher, sender),
                )
            })
        },
    );

    let stream = futures_util::stream::select(task_stream, stream).boxed();

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}
