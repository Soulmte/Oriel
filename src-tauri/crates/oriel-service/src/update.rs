//! Release check against GitHub, with the Gitee mirror and an optional CDN.
//!
//! Assets are merged by name so the UI can try the mirror first and fall back
//! to GitHub without a second round trip.

use std::time::Duration;

use serde_json::{json, Value};

use oriel_core::CoreError;

fn repo(kind: &str) -> String {
    let key = match kind {
        "gitee" => "ORIEL_UPDATE_GITEE",
        _ => "ORIEL_UPDATE_REPO",
    };
    std::env::var(key)
        .unwrap_or_else(|_| "Soulmte/Oriel".to_string())
        .trim()
        .to_string()
}

fn cdn() -> String {
    std::env::var("ORIEL_UPDATE_CDN")
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string()
}

fn parse_version(value: &str) -> Vec<u32> {
    value
        .trim_start_matches('v')
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

/// GitHub appends `**Full Changelog**: <compare url>` to generated release
/// notes. Split it out so the UI can offer it as a link instead of raw text.
fn split_changelog(body: &str) -> (String, Option<String>) {
    let normalized = body.replace("\r\n", "\n");
    let mut kept: Vec<&str> = Vec::new();
    let mut compare = None;

    for line in normalized.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("full changelog") || lower.starts_with("**full changelog**") {
            if let Some(index) = trimmed.find("http") {
                let url = trimmed[index..]
                    .trim()
                    .trim_end_matches(['.', ',', ';']);
                compare = Some(url.to_string());
            }
            continue;
        }
        kept.push(line);
    }

    (kept.join("\n").trim().to_string(), compare)
}

/// `https://github.com/owner/repo/compare/base...head` → repo + range.
fn parse_compare_url(url: &str) -> Option<(String, String)> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))?;
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next()? != "compare" {
        return None;
    }
    let range = parts.next()?.split(['?', '#']).next()?;
    if !range.contains("...") {
        return None;
    }
    Some((format!("{owner}/{repo}"), range.to_string()))
}

/// Fallback changelog when the release body only carries the auto-generated
/// compare line: list the commits the release is made of.
fn commit_notes(compare_url: &str) -> Option<String> {
    let (repository, range) = parse_compare_url(compare_url)?;
    let value = fetch(&format!(
        "https://api.github.com/repos/{repository}/compare/{range}"
    ))?;
    let commits = value.get("commits")?.as_array()?;
    if commits.is_empty() {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    for commit in commits.iter().take(40) {
        let message = commit
            .get("commit")
            .and_then(|value| value.get("message"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let title = message.lines().next().unwrap_or("").trim();
        if title.is_empty() || title.starts_with("Merge ") {
            continue;
        }
        let sha = commit
            .get("sha")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let short = &sha[..sha.len().min(7)];
        if short.is_empty() {
            lines.push(format!("- {title}"));
        } else {
            lines.push(format!("- {title} (`{short}`)"));
        }
    }

    if lines.is_empty() {
        return None;
    }

    let mut out = format!("本次发布包含 {} 个提交：\n\n", commits.len());
    out.push_str(&lines.join("\n"));
    if commits.len() > lines.len() {
        out.push_str(&format!("\n\n…以及另外 {} 个提交", commits.len() - lines.len()));
    }
    Some(out)
}

fn fetch(url: &str) -> Option<Value> {
    let response = ureq::get(url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "Oriel")
        .timeout(Duration::from_secs(12))
        .call()
        .ok()?;
    response.into_json::<Value>().ok()
}

struct Release {
    tag: String,
    /// Human title of the release, e.g. `Oriel 0.1.2`.
    name: Option<String>,
    notes: Option<String>,
    published: Option<String>,
    html_url: Option<String>,
    assets: Vec<(String, String, u64)>,
}

fn github_release(repository: &str) -> Option<Release> {
    let value = fetch(&format!(
        "https://api.github.com/repos/{repository}/releases/latest"
    ))?;
    Some(Release {
        tag: value.get("tag_name")?.as_str()?.to_string(),
        name: value
            .get("name")
            .and_then(|name| name.as_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        notes: value
            .get("body")
            .and_then(|body| body.as_str())
            .map(|body| body.to_string()),
        published: value
            .get("published_at")
            .and_then(|at| at.as_str())
            .map(|at| at.to_string()),
        html_url: value
            .get("html_url")
            .and_then(|url| url.as_str())
            .map(|url| url.to_string()),
        assets: value
            .get("assets")
            .and_then(|assets| assets.as_array())
            .map(|assets| {
                assets
                    .iter()
                    .filter_map(|asset| {
                        let name = asset.get("name")?.as_str()?.to_string();
                        let url = asset.get("browser_download_url")?.as_str()?.to_string();
                        let size = asset.get("size").and_then(|size| size.as_u64()).unwrap_or(0);
                        Some((name, url, size))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn gitee_release(repository: &str) -> Option<Release> {
    let value = fetch(&format!(
        "https://gitee.com/api/v5/repos/{repository}/releases/latest"
    ))?;
    Some(Release {
        tag: value.get("tag_name")?.as_str()?.to_string(),
        name: value
            .get("name")
            .and_then(|name| name.as_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        notes: value
            .get("body")
            .and_then(|body| body.as_str())
            .map(|body| body.to_string()),
        published: value
            .get("created_at")
            .and_then(|at| at.as_str())
            .map(|at| at.to_string()),
        html_url: Some(format!("https://gitee.com/{repository}/releases")),
        assets: value
            .get("assets")
            .and_then(|assets| assets.as_array())
            .map(|assets| {
                assets
                    .iter()
                    .filter_map(|asset| {
                        let name = asset.get("name")?.as_str()?.to_string();
                        let url = asset.get("browser_download_url")?.as_str()?.to_string();
                        let size = asset.get("size").and_then(|size| size.as_u64()).unwrap_or(0);
                        Some((name, url, size))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn check(current: &str) -> Value {
    let repository = repo("github");
    if repository.is_empty() {
        return json!({
            "configured": false,
            "current": current,
            "latest": null,
            "newer": false,
            "url": null,
            "releaseName": null,
            "notes": null,
            "compareUrl": null,
            "publishedAt": null,
            "assets": [],
        });
    }

    let github = github_release(&repository);
    let gitee = gitee_release(&repo("gitee"));
    let mirror_assets = match &gitee {
        Some(release) => release.assets.clone(),
        None => Vec::new(),
    };

    let (tag, release_name, notes, published, url, primary) = match (github, gitee) {
        (Some(github), _gitee) => (
            github.tag.clone(),
            github.name.clone(),
            github.notes.clone(),
            github.published.clone(),
            github.html_url.clone(),
            github.assets,
        ),
        (None, Some(gitee)) => (
            gitee.tag.clone(),
            gitee.name.clone(),
            gitee.notes.clone(),
            gitee.published.clone(),
            gitee.html_url.clone(),
            gitee.assets,
        ),
        (None, None) => {
            return json!({
                "configured": true,
                "current": current,
                "latest": null,
                "newer": false,
                "url": null,
                "releaseName": null,
                "notes": null,
                "compareUrl": null,
                "publishedAt": null,
                "assets": [],
                "error": "无法连接更新服务，请检查网络",
            })
        }
    };

    let mirror = mirror_assets;

    // Pull the auto-generated compare link out of the notes. When the author
    // left the body empty, use the commits in that range as the changelog.
    let (notes, compare_url) = match notes {
        Some(raw) => {
            let (body, compare) = split_changelog(&raw);
            let notes = if body.is_empty() {
                compare.as_deref().and_then(commit_notes)
            } else {
                Some(body)
            };
            (notes, compare)
        }
        None => (None, None),
    };

    let prefix = cdn();
    let mut assets: Vec<Value> = Vec::new();
    for (name, github_url, size) in primary {
        let mirror_url = mirror
            .iter()
            .find(|(mirror_name, _, _)| mirror_name == &name)
            .map(|(_, url, _)| url.clone());
        let preferred = if !prefix.is_empty() {
            format!("{prefix}/{tag}/{name}")
        } else {
            github_url.clone()
        };
        assets.push(json!({
            "name": name,
            "url": preferred,
            "mirrorUrl": mirror_url,
            "sourceUrl": github_url,
            "size": size,
        }));
    }

    let latest = tag.trim_start_matches('v').to_string();
    json!({
        "configured": true,
        "current": current,
        "latest": latest,
        "newer": is_newer(&tag, current),
        "url": url,
        "releaseName": release_name,
        "notes": notes,
        "compareUrl": compare_url,
        "publishedAt": published,
        "assets": assets,
    })
}

pub fn download(urls: &[String], name: &str) -> Result<std::path::PathBuf, CoreError> {
    let safe_name = name
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect::<String>();
    let destination = std::env::temp_dir().join(if safe_name.trim().is_empty() {
        "oriel-update.bin".to_string()
    } else {
        safe_name
    });

    let mut last_error = String::new();
    for url in urls {
        match ureq::get(url).timeout(Duration::from_secs(30)).call() {
            Ok(response) => {
                let mut file = std::fs::File::create(&destination)
                    .map_err(|error| CoreError::internal(error.to_string()))?;
                let mut reader = response.into_reader();
                std::io::copy(&mut reader, &mut file)
                    .map_err(|error| CoreError::internal(error.to_string()))?;
                return Ok(destination);
            }
            Err(error) => last_error = error.to_string(),
        }
    }

    Err(CoreError::bad_request(
        "DOWNLOAD_FAILED",
        if last_error.is_empty() {
            "下载失败".to_string()
        } else {
            format!("下载失败：{last_error}")
        },
    ))
}
