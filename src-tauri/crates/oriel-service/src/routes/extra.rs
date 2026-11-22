use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use oriel_core::{paths, recycle, thumbs};

use crate::routes::fs::PathQuery;
use crate::{archive, update, ApiResult, AppState, CoreError};

#[derive(Deserialize, Default)]
pub struct IdsBody {
    pub ids: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
pub struct ExtractBody {
    pub path: Option<String>,
    pub target: Option<String>,
    pub policy: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct CreateArchiveBody {
    pub sources: Option<Vec<String>>,
    pub target: Option<String>,
    pub name: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct DownloadBody {
    pub urls: Option<Vec<String>>,
    pub name: Option<String>,
    pub url: Option<String>,
    pub size: Option<u64>,
}

#[derive(Deserialize, Default)]
pub struct UpdateQuery {
    pub refresh: Option<String>,
}

fn ids_of(body: IdsBody) -> Result<Vec<String>, CoreError> {
    let ids = body.ids.unwrap_or_default();
    if ids.is_empty() {
        return Err(CoreError::bad_request("INVALID_BODY", "没有选中要操作的项目"));
    }
    Ok(ids)
}

pub async fn thumbnail(Query(query): Query<PathQuery>) -> ApiResult<Response> {
    let target = paths::normalize_path(query.path.as_deref())?;
    let size = thumbs::normalize_size(query.size);
    let bytes = tokio::task::spawn_blocking(move || thumbs::thumbnail(&target, size))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .body(Body::from(bytes))
        .map_err(|error| CoreError::internal(error.to_string()).into())
}

pub async fn recycle_list() -> ApiResult<Json<Value>> {
    let list = tokio::task::spawn_blocking(recycle::list)
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!(list)))
}

pub async fn recycle_restore(Json(body): Json<IdsBody>) -> ApiResult<Json<Value>> {
    let ids = ids_of(body)?;
    let (restored, skipped) = tokio::task::spawn_blocking(move || recycle::restore(&ids))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!({ "restored": restored, "skipped": skipped })))
}

pub async fn recycle_purge(Json(body): Json<IdsBody>) -> ApiResult<Json<Value>> {
    let ids = ids_of(body)?;
    let (purged, skipped) = tokio::task::spawn_blocking(move || recycle::purge(&ids))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!({ "purged": purged, "skipped": skipped })))
}

pub async fn recycle_empty() -> ApiResult<Json<Value>> {
    let (purged, skipped) = tokio::task::spawn_blocking(recycle::empty)
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!({ "purged": purged, "skipped": skipped })))
}

pub async fn extract_archive(Json(body): Json<ExtractBody>) -> ApiResult<Json<Value>> {
    let path = body.path.unwrap_or_default();
    let target = paths::normalize_path(body.target.as_deref())?;
    let policy = body.policy.unwrap_or_else(|| "skip".to_string());
    let extracted = tokio::task::spawn_blocking(move || archive::extract(&path, &target, &policy))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "extracted": extracted })))
}

pub async fn create_archive(Json(body): Json<CreateArchiveBody>) -> ApiResult<Json<Value>> {
    let mut sources = Vec::new();
    for value in body.sources.unwrap_or_default() {
        sources.push(paths::normalize(&value)?);
    }
    if sources.is_empty() {
        return Err(CoreError::bad_request("INVALID_BODY", "缺少要压缩的项目").into());
    }
    let target = paths::normalize_path(body.target.as_deref())?;
    let name = body.name.unwrap_or_else(|| "archive.zip".to_string());
    let created = tokio::task::spawn_blocking(move || archive::create(&sources, &target, &name))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "path": created })))
}

pub async fn update_check(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    Query(query): Query<UpdateQuery>,
) -> ApiResult<Json<Value>> {
    let current = state.app_version.clone();
    let refresh = query.refresh.as_deref() == Some("1");
    let value = tokio::task::spawn_blocking(move || update::check_with(&current, refresh))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(value))
}

pub async fn update_download(Json(body): Json<DownloadBody>) -> ApiResult<Json<Value>> {
    let mut urls = body.urls.unwrap_or_default();
    if let Some(single) = body.url {
        urls.insert(0, single);
    }
    if urls.is_empty() {
        return Err(CoreError::bad_request("INVALID_BODY", "缺少下载地址").into());
    }
    let name = body.name.unwrap_or_else(|| "oriel-update.bin".to_string());
    let size = body.size.unwrap_or(0);
    let task = tokio::task::spawn_blocking(move || crate::tasks::create_download(urls, name, size))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!(task)))
}
