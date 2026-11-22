//! Local REST service for Oriel.
//!
//! Same routes, same JSON shapes, same SSE names as the Node service it
//! replaces, so the web client does not change. What is different is the work
//! underneath: native enumeration, native icons, native port tables.

pub mod archive;
pub mod ooxml;
pub mod routes;
pub mod tasks;
pub mod update;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};

pub use oriel_core::CoreError;

#[derive(Clone)]
pub struct AppState {
    pub service_pid: u32,
    pub service_port: u16,
    pub app_version: String,
    pub started: std::time::Instant,
}

impl AppState {
    pub fn new(port: u16, app_version: impl Into<String>) -> Self {
        Self {
            service_pid: std::process::id(),
            service_port: port,
            app_version: app_version.into(),
            started: std::time::Instant::now(),
        }
    }
}

/// Error body the web client already understands: `{ error: { code, message } }`.
pub struct ApiError(pub CoreError);

impl From<CoreError> for ApiError {
    fn from(error: CoreError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = json!({ "error": { "code": self.0.code, "message": self.0.message } });
        (status, Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

pub fn router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/health", get(routes::system::health))
        .route("/api/system/info", get(routes::system::info))
        .route("/api/drives", get(routes::system::drives))
        .route("/api/special", get(routes::system::special))
        .route("/api/system/fonts", get(routes::system::fonts))
        .route("/api/system/ports", get(routes::system::ports))
        .route("/api/system/ports/kill", post(routes::system::kill_port))
        .route("/api/system/processes", get(routes::system::processes))
        .route("/api/system/processes/kill", post(routes::system::kill_process))
        .route("/api/system/locks", get(routes::system::locks))
        .route("/api/system/cleanup", get(routes::system::cleanup))
        .route("/api/system/cleanup/clean", post(routes::system::cleanup_run))
        .route(
            "/api/system/cleanup/stream",
            get(routes::system::cleanup_stream),
        )
        .route(
            "/api/system/cleanup/categories",
            get(routes::system::cleanup_categories),
        )
        .route("/api/system/apps", get(routes::system::installed_apps))
        .route(
            "/api/system/apps/uninstall",
            post(routes::system::app_uninstall),
        )
        .route("/api/system/apps/status", post(routes::system::app_status))
        .route("/api/system/apps/sizes", post(routes::system::app_sizes))
        .route(
            "/api/system/apps/leftovers",
            post(routes::system::app_leftovers),
        )
        .route("/api/system/apps/clean", post(routes::system::app_clean))
        .route("/api/fs/list", get(routes::fs::list))
        .route("/api/fs/stat", get(routes::fs::stat))
        .route("/api/fs/entries", post(routes::fs::entries))
        .route("/api/fs/resolve", get(routes::fs::resolve))
        .route("/api/fs/preview", get(routes::fs::preview))
        .route("/api/fs/info", get(routes::fs::info))
        .route("/api/fs/size", get(routes::fs::size))
        .route("/api/fs/sizes", post(routes::fs::sizes))
        .route("/api/fs/icons", post(routes::fs::icons))
        .route("/api/fs/download", get(routes::fs::download))
        .route("/api/fs/media", get(routes::fs::media))
        .route("/api/fs/search", get(routes::fs::search))
        .route("/api/fs/search/stream", get(routes::fs::search_stream))
        .route("/api/fs/thumbnail", get(routes::extra::thumbnail))
        .route("/api/fs/mkdir", post(routes::write::mkdir))
        .route("/api/fs/new-file", post(routes::write::new_file))
        .route("/api/fs/new-office-file", post(routes::write::new_office_file))
        .route("/api/fs/terminal", post(routes::write::terminal))
        .route("/api/fs/rename", post(routes::write::rename))
        .route("/api/fs/batch-rename", post(routes::write::batch_rename))
        .route("/api/fs/copy", post(routes::write::copy))
        .route("/api/fs/move", post(routes::write::move_entries))
        .route("/api/fs/delete", post(routes::write::delete))
        .route("/api/fs/clipboard", get(routes::write::read_clipboard).post(routes::write::set_clipboard))
        .route("/api/fs/conflicts", post(routes::write::conflicts))
        .route("/api/fs/transfer", post(routes::write::transfer))
        .route("/api/fs/tasks/{id}", get(routes::write::task))
        .route("/api/fs/tasks/{id}/cancel", post(routes::write::cancel_task))
        .route("/api/fs/tasks/{id}/pause", post(routes::write::pause_task))
        .route("/api/fs/tasks/{id}/resume", post(routes::write::resume_task))
        .route("/api/fs/tasks/{id}/retry", post(routes::write::retry_task))
        .route("/api/fs/open", post(routes::write::open))
        .route("/api/fs/reveal", post(routes::write::reveal))
        .route("/api/recycle", get(routes::extra::recycle_list))
        .route("/api/recycle/restore", post(routes::extra::recycle_restore))
        .route("/api/recycle/purge", post(routes::extra::recycle_purge))
        .route("/api/recycle/empty", post(routes::extra::recycle_empty))
        .route("/api/archive/extract", post(routes::extra::extract_archive))
        .route("/api/archive/create", post(routes::extra::create_archive))
        .route("/api/app/update", get(routes::extra::update_check))
        .route("/api/app/update/download", post(routes::extra::update_download))
        .route("/api/events", get(routes::fs::events))
        .fallback(routes::not_migrated)
        .layer(cors)
        .with_state(Arc::new(state))
}

/// Serves until the process is terminated. Used by the Tauri shell and by
/// `oriel-service` when it runs standalone.
pub async fn serve(state: AppState, addr: SocketAddr) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(state)).await
}

pub async fn serve_on(port: u16, app_version: impl Into<String>) -> std::io::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    serve(AppState::new(port, app_version), addr).await
}

/// Optional shared-secret check, matching the old `ORIEL_TOKEN` behaviour.
pub fn token_ok(headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let expected = match std::env::var("ORIEL_TOKEN") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return true,
    };
    let header = headers
        .get("x-api-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    header == expected.trim() || query_token.map(|value| value == expected.trim()).unwrap_or(false)
}
