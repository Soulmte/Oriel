pub mod extra;
pub mod fs;
pub mod system;
pub mod write;

use crate::{ApiError, CoreError};

/// Anything the Rust service does not serve yet. The migration is tracked by
/// this code: when it is gone, every route lives here.
pub async fn not_migrated() -> ApiError {
    ApiError(CoreError::new(
        404,
        "NOT_FOUND",
        "该接口尚未迁移到本地 Rust 服务",
    ))
}
