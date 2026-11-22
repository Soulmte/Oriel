use std::env;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub platform: &'static str,
    pub release: String,
    pub hostname: String,
    pub home: String,
    pub sep: &'static str,
    pub app_version: String,
    pub node_version: String,
}

fn hostname() -> String {
    env::var("COMPUTERNAME")
        .or_else(|_| env::var("HOSTNAME"))
        .unwrap_or_else(|_| "windows".to_string())
}

pub fn info(app_version: &str) -> SystemInfo {
    let home = env::var("USERPROFILE").unwrap_or_default();
    SystemInfo {
        platform: "win32",
        release: "Windows".to_string(),
        hostname: hostname(),
        home,
        sep: "\\",
        app_version: app_version.to_string(),
        node_version: "rust".to_string(),
    }
}
