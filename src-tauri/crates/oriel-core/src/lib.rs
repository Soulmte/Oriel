//! Native primitives for Oriel.
//!
//! Everything in this crate is pure Rust over the Windows APIs: no shelling out
//! to PowerShell, no per-entry `stat` when one directory enumeration already
//! carries the attributes. The service layer (`oriel-service`) turns these into
//! HTTP routes, and the Tauri shell only starts that service.

pub mod apps;
pub mod clipboard;
pub mod cleanup;
pub mod drives;
pub mod entry;
pub mod error;
pub mod fonts;
pub mod fsops;
pub mod icons;
pub mod info;
pub mod locks;
pub mod mime;
pub mod paths;
pub mod ports;
pub mod processes;
pub mod recycle;
pub mod search;
pub mod special;
pub mod system;
pub mod thumbs;

pub use entry::Entry;
pub use error::{CoreError, Result};

/// Milliseconds since the Unix epoch, matching the DTO field the web client uses.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}
