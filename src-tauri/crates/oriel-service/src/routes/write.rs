use axum::extract::Path as AxumPath;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use oriel_core::{clipboard, entry, fsops, paths};

use crate::tasks;
use crate::{ApiResult, AppState, CoreError};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MkdirBody {
    pub path: Option<String>,
    pub name: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewFileBody {
    pub path: Option<String>,
    pub name: Option<String>,
    pub content: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewOfficeBody {
    pub path: Option<String>,
    pub name: Option<String>,
    pub template: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenameBody {
    pub path: Option<String>,
    pub new_name: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct BatchItem {
    pub path: Option<String>,
    pub name: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct BatchBody {
    pub items: Option<Vec<BatchItem>>,
}

#[derive(Deserialize, Default)]
pub struct PathsBody {
    pub paths: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
pub struct SourcesBody {
    pub sources: Option<Vec<String>>,
    pub target: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct DeleteBody {
    pub paths: Option<Vec<String>>,
    pub permanent: Option<bool>,
}

#[derive(Deserialize, Default)]
pub struct ClipboardBody {
    pub paths: Option<Vec<String>>,
    pub cut: Option<bool>,
}

#[derive(Deserialize, Default)]
pub struct TransferBody {
    pub kind: Option<String>,
    pub sources: Option<Vec<String>>,
    pub target: Option<String>,
    pub policy: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct OnePathBody {
    pub path: Option<String>,
}

fn require_path(value: Option<String>) -> ApiResult<String> {
    Ok(paths::normalize_path(value.as_deref())?)
}

pub async fn mkdir(Json(body): Json<MkdirBody>) -> ApiResult<Json<Value>> {
    let parent = require_path(body.path)?;
    let name = body.name.unwrap_or_default();
    let created = tokio::task::spawn_blocking(move || fsops::create_folder(&parent, &name))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "path": created })))
}

pub async fn new_file(Json(body): Json<NewFileBody>) -> ApiResult<Json<Value>> {
    let parent = require_path(body.path)?;
    let name = body.name.unwrap_or_default();
    let content = body.content.unwrap_or_default().into_bytes();
    let created = tokio::task::spawn_blocking(move || fsops::create_file(&parent, &name, &content))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "path": created })))
}

pub async fn new_office_file(Json(body): Json<NewOfficeBody>) -> ApiResult<Json<Value>> {
    let parent = require_path(body.path)?;
    let name = body.name.unwrap_or_default();
    let template = body.template.unwrap_or_else(|| "docx".to_string());
    let bytes = crate::ooxml::build(&template)
        .ok_or_else(|| CoreError::bad_request("INVALID_TEMPLATE", "不支持的模板类型"))?;
    let created = tokio::task::spawn_blocking(move || fsops::create_file(&parent, &name, &bytes))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "path": created })))
}

pub async fn rename(Json(body): Json<RenameBody>) -> ApiResult<Json<Value>> {
    let target = require_path(body.path)?;
    let new_name = body.new_name.unwrap_or_default();
    let renamed = tokio::task::spawn_blocking(move || fsops::rename_entry(&target, &new_name))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "path": renamed })))
}

pub async fn batch_rename(Json(body): Json<BatchBody>) -> ApiResult<Json<Value>> {
    let mut items: Vec<(String, String)> = Vec::new();
    for item in body.items.unwrap_or_default() {
        let path = require_path(item.path)?;
        items.push((path, item.name.unwrap_or_default()));
    }
    let moves = tokio::task::spawn_blocking(move || fsops::batch_rename(&items))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    let renamed: Vec<Value> = moves
        .into_iter()
        .map(|(from, to)| json!({ "from": from, "to": to }))
        .collect();
    Ok(Json(json!({ "renamed": renamed })))
}

fn normalize_list(values: Option<Vec<String>>) -> ApiResult<Vec<String>> {
    let list = values.unwrap_or_default();
    if list.is_empty() {
        return Err(CoreError::bad_request("INVALID_BODY", "缺少要操作的项目").into());
    }
    let mut out = Vec::with_capacity(list.len());
    for value in list {
        out.push(paths::normalize(&value)?);
    }
    Ok(out)
}

fn copy_sources(sources: Vec<String>, target: String) -> Result<Vec<String>, CoreError> {
    let stat = entry::stat(&target)?;
    if stat.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "目标不是文件夹"));
    }
    let mut created = Vec::new();
    for source in sources {
        entry::stat(&source)?;
        let destination = paths::join(&target, &paths::file_name_of(&source));
        if paths::is_same_path(&source, &destination) {
            continue;
        }
        if paths::is_within(&source, &destination) {
            return Err(CoreError::bad_request(
                "INVALID_TARGET",
                "不能将文件夹复制到其自身内部",
            ));
        }
        if entry::exists(&destination) {
            return Err(CoreError::new(
                409,
                "CONFLICT",
                format!("“{}” 已存在", paths::file_name_of(&source)),
            ));
        }
        fsops::copy_tree(&source, &destination, &fsops::Free, &mut |_| {})?;
        created.push(destination);
    }
    Ok(created)
}

fn move_sources(sources: Vec<String>, target: String) -> Result<Vec<String>, CoreError> {
    let stat = entry::stat(&target)?;
    if stat.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "目标不是文件夹"));
    }
    let mut moved = Vec::new();
    for source in sources {
        entry::stat(&source)?;
        let destination = paths::join(&target, &paths::file_name_of(&source));
        if paths::is_same_path(&source, &destination) {
            continue;
        }
        if paths::is_within(&source, &destination) {
            return Err(CoreError::bad_request(
                "INVALID_TARGET",
                "不能将文件夹移动到其自身内部",
            ));
        }
        if entry::exists(&destination) {
            return Err(CoreError::new(
                409,
                "CONFLICT",
                format!("“{}” 已存在", paths::file_name_of(&source)),
            ));
        }
        fsops::move_entry(&source, &destination, &fsops::Free, &mut |_| {})?;
        moved.push(destination);
    }
    Ok(moved)
}

pub async fn copy(Json(body): Json<SourcesBody>) -> ApiResult<Json<Value>> {
    let sources = normalize_list(body.sources)?;
    let target = require_path(body.target)?;
    let created = tokio::task::spawn_blocking(move || copy_sources(sources, target))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "paths": created })))
}

pub async fn move_entries(Json(body): Json<SourcesBody>) -> ApiResult<Json<Value>> {
    let sources = normalize_list(body.sources)?;
    let target = require_path(body.target)?;
    let moved = tokio::task::spawn_blocking(move || move_sources(sources, target))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "paths": moved })))
}

pub async fn delete(Json(body): Json<DeleteBody>) -> ApiResult<Json<Value>> {
    let targets = normalize_list(body.paths)?;
    let permanent = body.permanent.unwrap_or(false);
    let count = tokio::task::spawn_blocking(move || -> Result<u32, CoreError> {
        if permanent {
            for target in &targets {
                fsops::remove_permanent(target)?;
            }
            Ok(targets.len() as u32)
        } else {
            fsops::delete_to_recycle(&targets)
        }
    })
    .await
    .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "deleted": count, "permanent": permanent })))
}

pub async fn set_clipboard(Json(body): Json<ClipboardBody>) -> ApiResult<Json<Value>> {
    let targets = normalize_list(body.paths)?;
    let cut = body.cut.unwrap_or(false);
    let count = tokio::task::spawn_blocking(move || clipboard::write(&targets, cut))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "ok": true, "count": count })))
}

pub async fn read_clipboard() -> Json<Value> {
    let result = tokio::task::spawn_blocking(clipboard::read).await;
    match result {
        Ok(Ok((paths, cut))) => Json(json!({ "paths": paths, "cut": cut })),
        _ => Json(json!({ "paths": [], "cut": false })),
    }
}

pub async fn conflicts(Json(body): Json<SourcesBody>) -> ApiResult<Json<Value>> {
    let sources = normalize_list(body.sources)?;
    let target = require_path(body.target)?;
    let pairs = tokio::task::spawn_blocking(move || tasks::find_conflicts(&sources, &target))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    let conflicts: Vec<Value> = pairs
        .into_iter()
        .map(|(source, destination)| json!({ "source": source, "destination": destination }))
        .collect();
    Ok(Json(json!({ "conflicts": conflicts })))
}

pub async fn transfer(Json(body): Json<TransferBody>) -> ApiResult<Json<Value>> {
    let sources = normalize_list(body.sources)?;
    let target = require_path(body.target)?;
    let kind = body.kind.unwrap_or_else(|| "copy".to_string());
    let policy = body.policy.unwrap_or_else(|| "rename".to_string());
    let stat = entry::stat(&target)?;
    if stat.kind != "directory" {
        return Err(CoreError::bad_request("NOT_A_DIRECTORY", "目标必须是文件夹").into());
    }
    for source in &sources {
        entry::stat(source)?;
    }
    let task = tokio::task::spawn_blocking(move || tasks::create_transfer(&kind, sources, target, &policy))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))?;
    Ok(Json(json!(task)))
}

pub async fn task(axum::extract::Path(id): axum::extract::Path<String>) -> ApiResult<Json<Value>> {
    match tasks::get(&id) {
        Some(task) => Ok(Json(json!(task))),
        None => Err(CoreError::not_found("任务不存在").into()),
    }
}

pub async fn cancel_task(axum::extract::Path(id): axum::extract::Path<String>) -> Json<Value> {
    Json(json!({ "cancelled": tasks::cancel(&id) }))
}

pub async fn pause_task(axum::extract::Path(id): axum::extract::Path<String>) -> Json<Value> {
    Json(json!({ "paused": tasks::pause(&id) }))
}

pub async fn resume_task(axum::extract::Path(id): axum::extract::Path<String>) -> Json<Value> {
    Json(json!({ "resumed": tasks::resume(&id) }))
}

pub async fn retry_task(axum::extract::Path(id): axum::extract::Path<String>) -> ApiResult<Json<Value>> {
    match tasks::retry(&id) {
        Some(task) => Ok(Json(json!(task))),
        None => Err(CoreError::not_found("该任务没有可重试的请求").into()),
    }
}

pub async fn open(Json(body): Json<OnePathBody>) -> ApiResult<Json<Value>> {
    let raw = body.path.unwrap_or_default();
    // Release pages and changelogs are URLs; everything else must be a real
    // absolute path, which `normalize_path` enforces.
    let target = if raw.trim().starts_with("http://") || raw.trim().starts_with("https://") {
        raw.trim().to_string()
    } else {
        require_path(Some(raw))?
    };
    tokio::task::spawn_blocking(move || fsops::open_with_system(&target))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "ok": true })))
}

pub async fn reveal(Json(body): Json<OnePathBody>) -> ApiResult<Json<Value>> {
    let target = require_path(body.path)?;
    tokio::task::spawn_blocking(move || fsops::reveal_in_system(&target))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "ok": true })))
}

pub async fn terminal(Json(body): Json<OnePathBody>) -> ApiResult<Json<Value>> {
    let target = require_path(body.path)?;
    tokio::task::spawn_blocking(move || fsops::open_terminal(&target))
        .await
        .map_err(|error| CoreError::internal(error.to_string()))??;
    Ok(Json(json!({ "ok": true })))
}

#[allow(dead_code)]
fn unused(_: Arc<AppState>, _: AxumPath<String>) {}
