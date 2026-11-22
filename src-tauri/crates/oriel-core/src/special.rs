use std::env;
use std::path::Path;

use serde::Serialize;

use crate::paths::join;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialFolder {
    pub id: &'static str,
    pub name: &'static str,
    pub path: String,
    pub icon: &'static str,
}

struct Candidate {
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    /// Relative to the home folder; `None` means the home folder itself.
    dirs: &'static [&'static str],
}

const CANDIDATES: [Candidate; 9] = [
    Candidate {
        id: "home",
        name: "个人",
        icon: "home",
        dirs: &[],
    },
    Candidate {
        id: "desktop",
        name: "桌面",
        icon: "desktop",
        dirs: &["Desktop", "桌面"],
    },
    Candidate {
        id: "documents",
        name: "文稿",
        icon: "documents",
        dirs: &["Documents", "文档"],
    },
    Candidate {
        id: "downloads",
        name: "下载",
        icon: "downloads",
        dirs: &["Downloads", "下载"],
    },
    Candidate {
        id: "pictures",
        name: "图片",
        icon: "pictures",
        dirs: &["Pictures", "图片"],
    },
    Candidate {
        id: "music",
        name: "音乐",
        icon: "music",
        dirs: &["Music", "音乐"],
    },
    Candidate {
        id: "videos",
        name: "影片",
        icon: "videos",
        dirs: &["Videos", "视频"],
    },
    Candidate {
        id: "applications",
        name: "应用程序",
        icon: "applications",
        dirs: &[],
    },
    Candidate {
        id: "tmp",
        name: "临时文件",
        icon: "tmp",
        dirs: &[],
    },
];

fn env_path(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

fn is_dir(target: &str) -> bool {
    Path::new(target).is_dir()
}

/// Known folders can be redirected by OneDrive or localized, so probe the
/// common spellings and keep the first one that exists.
pub fn list() -> Vec<SpecialFolder> {
    let home = env_path("USERPROFILE").unwrap_or_default();
    let one_drive = env_path("OneDrive").unwrap_or_else(|| join(&home, "OneDrive"));
    let program_files =
        env_path("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".to_string());
    let temp = env::temp_dir().to_string_lossy().to_string();

    let mut out = Vec::new();
    for candidate in CANDIDATES {
        let mut resolved: Option<String> = None;
        match candidate.id {
            "home" => {
                if is_dir(&home) {
                    resolved = Some(home.clone());
                }
            }
            "applications" => {
                if is_dir(&program_files) {
                    resolved = Some(program_files.clone());
                }
            }
            "tmp" => {
                if is_dir(&temp) {
                    resolved = Some(temp.clone());
                }
            }
            _ => {
                for dir in candidate.dirs {
                    let root = join(&home, dir);
                    if is_dir(&root) {
                        resolved = Some(root);
                        break;
                    }
                    let redirected = join(&one_drive, dir);
                    if is_dir(&redirected) {
                        resolved = Some(redirected);
                        break;
                    }
                }
            }
        }

        if let Some(path) = resolved {
            out.push(SpecialFolder {
                id: candidate.id,
                name: candidate.name,
                path,
                icon: candidate.icon,
            });
        }
    }
    out
}
