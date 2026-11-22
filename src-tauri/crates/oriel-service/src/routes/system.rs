use std::convert::Infallible;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::stream::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use oriel_core::cleanup::CleanupEvent;
use oriel_core::{apps, cleanup, drives, fonts, locks, ports, processes, special, system};

use crate::{ApiResult, AppState, CoreError};

#[derive(Deserialize)]
pub struct PortsQuery {
    #[serde(default)]
    #[allow(dead_code)]
    refresh: Option<String>,
}

#[derive(Deserialize)]
pub struct KillBody {
    pid: Option<u32>,
}

#[derive(Deserialize)]
pub struct LocksQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
pub struct CleanupQuery {
    drive: Option<String>,
}

#[derive(Deserialize)]
pub struct CleanupBody {
    ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct CleanupStreamQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
pub struct UninstallBody {
    id: Option<String>,
    quiet: Option<bool>,
}

#[derive(Deserialize)]
pub struct AppBody {
    id: Option<String>,
}

#[derive(Deserialize)]
pub struct AppCleanBody {
    id: Option<String>,
    registry: Option<Vec<String>>,
    paths: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct AppStatusBody {
    pid: Option<u32>,
}

#[derive(Deserialize)]
pub struct AppSizesBody {
    ids: Option<Vec<String>>,
}

pub async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "name": "Oriel",
        "version": state.app_version,
        "uptime": state.started.elapsed().as_secs(),
    }))
}

pub async fn info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let info = system::info(&state.app_version);
    Json(json!(info))
}

pub async fn drives() -> ApiResult<Json<Value>> {
    let list = tokio::task::spawn_blocking(|| drives::list(false))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!(list)))
}

pub async fn special() -> ApiResult<Json<Value>> {
    let list = tokio::task::spawn_blocking(special::list)
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!(list)))
}

pub async fn fonts() -> ApiResult<Json<Value>> {
    let list = tokio::task::spawn_blocking(fonts::list)
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!({ "fonts": list })))
}

pub async fn ports(
    State(state): State<Arc<AppState>>,
    Query(_query): Query<PortsQuery>,
) -> ApiResult<Json<Value>> {
    let pid = state.service_pid;
    let port = state.service_port;
    let list = tokio::task::spawn_blocking(move || ports::list(pid, port))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!(list)))
}

pub async fn kill_port(State(state): State<Arc<AppState>>, Json(body): Json<KillBody>) -> ApiResult<Json<Value>> {
    let pid = body
        .pid
        .ok_or_else(|| CoreError::bad_request("INVALID_PID", "进程号无效"))?;
    let service_pid = state.service_pid;
    tokio::task::spawn_blocking(move || ports::kill(pid, service_pid))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "ok": true, "pid": pid })))
}

pub async fn processes(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let service_pid = state.service_pid;
    let list = tokio::task::spawn_blocking(move || processes::list(service_pid))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!({ "items": list, "servicePid": service_pid })))
}

pub async fn kill_process(
    State(state): State<Arc<AppState>>,
    Json(body): Json<KillBody>,
) -> ApiResult<Json<Value>> {
    let pid = body
        .pid
        .ok_or_else(|| CoreError::bad_request("INVALID_PID", "进程号无效"))?;
    let service_pid = state.service_pid;
    tokio::task::spawn_blocking(move || processes::kill(pid, service_pid))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "ok": true, "pid": pid })))
}

pub async fn locks(
    State(state): State<Arc<AppState>>,
    Query(query): Query<LocksQuery>,
) -> ApiResult<Json<Value>> {
    let path = query.path.unwrap_or_default();
    let service_pid = state.service_pid;
    let list = tokio::task::spawn_blocking(move || locks::who_locks(&path, service_pid))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!(list)))
}

pub async fn cleanup(
    Query(query): Query<CleanupQuery>,
) -> ApiResult<Json<Value>> {
    let drive = query.drive.unwrap_or_else(|| "C".to_string());
    let report = tokio::task::spawn_blocking(move || cleanup::analyze(&drive))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!(report)))
}

pub async fn cleanup_run(Json(body): Json<CleanupBody>) -> ApiResult<Json<Value>> {
    let ids = body.ids.unwrap_or_default();
    if ids.is_empty() {
        return Err(CoreError::bad_request(
            "INVALID_TARGET",
            "请选择要清理的项目",
        )
        .into());
    }
    let result = tokio::task::spawn_blocking(move || cleanup::clean(&ids))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!(result)))
}

fn cleanup_event(event: CleanupEvent) -> Event {
    match event {
        CleanupEvent::Meta {
            path,
            parent,
            drive,
            total,
            free,
            used,
            elevated,
        } => Event::default().event("meta").data(
            json!({
                "path": path,
                "parent": parent,
                "drive": drive,
                "total": total,
                "free": free,
                "used": used,
                "elevated": elevated,
            })
            .to_string(),
        ),
        CleanupEvent::Category(category) => Event::default()
            .event("category")
            .data(json!(category).to_string()),
        CleanupEvent::Scan { name, path } => Event::default()
            .event("scan")
            .data(json!({ "name": name, "path": path }).to_string()),
        CleanupEvent::Node {
            name,
            path,
            kind,
            size,
            files,
            complete,
            partial,
        } => Event::default().event("node").data(
            json!({
                "name": name,
                "path": path,
                "kind": kind,
                "size": size,
                "files": files,
                "complete": complete,
                "partial": partial,
            })
            .to_string(),
        ),
        CleanupEvent::Done {
            partial,
            scanned_at,
        } => Event::default().event("done").data(
            json!({ "partial": partial, "scannedAt": scanned_at }).to_string(),
        ),
        CleanupEvent::Error(message) => Event::default()
            .event("error")
            .data(json!({ "message": message }).to_string()),
    }
}

fn cleanup_sse(receiver: tokio::sync::mpsc::Receiver<CleanupEvent>) -> Response {
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|event| (Ok::<Event, Infallible>(cleanup_event(event)), receiver))
    })
    .boxed();
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

pub async fn cleanup_stream(Query(query): Query<CleanupStreamQuery>) -> Response {
    let path = query.path.unwrap_or_else(|| "C:\\".to_string());
    let (sender, receiver) = tokio::sync::mpsc::channel::<CleanupEvent>(256);
    std::thread::spawn(move || {
        cleanup::stream_tree(&path, |event| {
            sender.blocking_send(event).is_ok()
        });
    });
    cleanup_sse(receiver)
}

pub async fn cleanup_categories() -> Response {
    let (sender, receiver) = tokio::sync::mpsc::channel::<CleanupEvent>(64);
    std::thread::spawn(move || {
        cleanup::stream_categories(|event| sender.blocking_send(event).is_ok());
    });
    cleanup_sse(receiver)
}

pub async fn installed_apps() -> ApiResult<Json<Value>> {
    let list = tokio::task::spawn_blocking(|| apps::list(true))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!(list)))
}

pub async fn app_sizes(Json(body): Json<AppSizesBody>) -> ApiResult<Json<Value>> {
    let ids = body.ids.unwrap_or_default();
    if ids.is_empty() {
        return Ok(Json(json!({ "sizes": {} })));
    }
    let sizes = tokio::task::spawn_blocking(move || apps::measure_sizes(&ids))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!({ "sizes": sizes })))
}

pub async fn app_uninstall(Json(body): Json<UninstallBody>) -> ApiResult<Json<Value>> {
    let id = body.id.unwrap_or_default().trim().to_string();
    if id.is_empty() {
        return Err(CoreError::bad_request("INVALID_APP", "缺少应用标识").into());
    }
    let quiet = body.quiet.unwrap_or(false);
    let pid = tokio::task::spawn_blocking(move || apps::launch(&id, quiet))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "ok": true, "pid": pid })))
}

pub async fn app_status(Json(body): Json<AppStatusBody>) -> ApiResult<Json<Value>> {
    let Some(pid) = body.pid.filter(|pid| *pid > 0) else {
        return Err(CoreError::bad_request("INVALID_PID", "进程号无效").into());
    };
    let running = tokio::task::spawn_blocking(move || apps::process_state(pid))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!({ "running": running })))
}

pub async fn app_leftovers(Json(body): Json<AppBody>) -> ApiResult<Json<Value>> {
    let id = body.id.unwrap_or_default().trim().to_string();
    if id.is_empty() {
        return Err(CoreError::bad_request("INVALID_APP", "缺少应用标识").into());
    }
    let report = tokio::task::spawn_blocking(move || apps::leftovers(&id))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!(report)))
}

pub async fn app_clean(Json(body): Json<AppCleanBody>) -> ApiResult<Json<Value>> {
    let id = body.id.unwrap_or_default().trim().to_string();
    if id.is_empty() {
        return Err(CoreError::bad_request("INVALID_APP", "缺少应用标识").into());
    }
    let registry = body.registry.unwrap_or_default();
    let paths = body.paths.unwrap_or_default();
    if registry.is_empty() && paths.is_empty() {
        return Err(CoreError::bad_request("INVALID_TARGET", "请选择要删除的残留项").into());
    }
    let report = tokio::task::spawn_blocking(move || apps::clean(&id, &registry, &paths))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!(report)))
}

#[allow(dead_code)]
fn elapsed_guard(started: Instant) -> u64 {
    started.elapsed().as_secs()
}
