use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use oriel_core::{drives, fonts, locks, ports, processes, special, system};

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

#[allow(dead_code)]
fn elapsed_guard(started: Instant) -> u64 {
    started.elapsed().as_secs()
}
