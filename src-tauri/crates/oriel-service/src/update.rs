//! Release check against GitHub, with the Gitee mirror and an optional CDN.
//!
//! Assets are merged by name so the UI can try the mirror first and fall back
//! to GitHub without a second round trip.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Runtime values win; otherwise use the value baked in by the release build.
/// The workflow sets these during `tauri build`, so shipped installers carry
/// the CDN/Gitee mirror without relying on the user's environment.
fn runtime_or_baked(runtime_key: &str, baked: Option<&str>, fallback: &str) -> String {
    std::env::var(runtime_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            baked
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn github_repo() -> String {
    runtime_or_baked(
        "ORIEL_UPDATE_REPO",
        option_env!("ORIEL_UPDATE_REPO"),
        "Soulmte/Oriel",
    )
}

fn gitee_repo() -> String {
    let runtime = std::env::var("ORIEL_UPDATE_GITEE")
        .ok()
        .or_else(|| std::env::var("ORIEL_UPDATE_GITEE_REPO").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = runtime {
        return value;
    }

    option_env!("ORIEL_UPDATE_GITEE_REPO")
        .or(option_env!("ORIEL_UPDATE_GITEE"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "rain-drops/oriel".to_string())
}

fn cdn() -> String {
    runtime_or_baked(
        "ORIEL_UPDATE_CDN",
        option_env!("ORIEL_UPDATE_CDN"),
        "",
    )
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
        .timeout(Duration::from_secs(8))
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

/// The Gitee REST API sits behind a WAF that answers 403 after only a handful
/// of anonymous calls. The mirror therefore also publishes `update.json` on
/// `main`: a raw file has no such limit and carries the sizes the API omits.
fn gitee_manifest(repository: &str) -> Option<Release> {
    let url = format!("https://gitee.com/{repository}/raw/main/update.json");
    let response = ureq::get(&url)
        .set("User-Agent", "Oriel")
        .timeout(Duration::from_secs(8))
        .call()
        .ok()?;
    // The raw endpoint serves the file as `text/plain`, which `into_json`
    // refuses, so read the body and parse it ourselves.
    let text = response.into_string().ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    manifest_from_value(repository, &value)
}

fn manifest_from_value(repository: &str, value: &Value) -> Option<Release> {
    let tag = value.get("tag")?.as_str()?.trim().to_string();
    if tag.is_empty() {
        return None;
    }

    let assets = value
        .get("assets")
        .and_then(|assets| assets.as_array())
        .map(|assets| {
            assets
                .iter()
                .filter_map(|asset| {
                    let name = asset.get("name")?.as_str()?.to_string();
                    let size = asset.get("size").and_then(|size| size.as_u64()).unwrap_or(0);
                    // Gitee serves release attachments from this fixed layout.
                    let url = format!(
                        "https://gitee.com/{repository}/releases/download/{tag}/{name}"
                    );
                    Some((name, url, size))
                })
                .collect()
        })
        .unwrap_or_default();

    Some(Release {
        tag: tag.clone(),
        name: value.get("name").and_then(|name| name.as_str()).map(str::to_string),
        notes: value
            .get("notes")
            .and_then(|notes| notes.as_str())
            .map(str::to_string),
        published: value
            .get("publishedAt")
            .and_then(|at| at.as_str())
            .map(str::to_string),
        html_url: Some(format!("https://gitee.com/{repository}/releases/tag/{tag}")),
        assets,
    })
}

fn cache() -> &'static Mutex<Option<(Instant, String, Value)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, String, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

const CHECK_TTL: Duration = Duration::from_secs(300);

pub fn check(current: &str) -> Value {
    check_with(current, false)
}

pub fn check_with(current: &str, refresh: bool) -> Value {
    if !refresh {
        if let Ok(cache) = cache().lock() {
            if let Some((at, cached_for, value)) = cache.as_ref() {
                if cached_for == current && at.elapsed() < CHECK_TTL {
                    return value.clone();
                }
            }
        }
    }

    let value = fetch_and_build(current);
    if let Ok(mut cache) = cache().lock() {
        *cache = Some((Instant::now(), current.to_string(), value.clone()));
    }
    value
}

fn unavailable(current: &str) -> Value {
    json!({
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

fn fetch_and_build(current: &str) -> Value {
    let github_id = github_repo();
    if github_id.is_empty() {
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
    let gitee_id = gitee_repo();

    // GitHub can hang for a long time behind the GFW; querying everything in
    // parallel means a blocked source costs one short timeout, not three
    // serial ones. The manifest is preferred over the API: it survives the
    // WAF and still knows each installer's size.
    let (github, gitee_api, gitee_file) = std::thread::scope(|scope| {
        let github = scope.spawn(|| github_release(&github_id));
        let api = scope.spawn(|| gitee_release(&gitee_id));
        let file = scope.spawn(|| gitee_manifest(&gitee_id));
        (
            github.join().ok().flatten(),
            api.join().ok().flatten(),
            file.join().ok().flatten(),
        )
    });
    let github_ok = github.is_some();

    let gitee = match (gitee_file, gitee_api) {
        (Some(file), Some(api)) => {
            if is_newer(&api.tag, &file.tag) {
                Some(api)
            } else {
                Some(file)
            }
        }
        (file, api) => file.or(api),
    };

    let primary = match (&github, &gitee) {
        (Some(github), Some(gitee)) => {
            if is_newer(&gitee.tag, &github.tag) {
                gitee
            } else {
                github
            }
        }
        (Some(github), None) => github,
        (None, Some(gitee)) => gitee,
        (None, None) => return unavailable(current),
    };

    let (notes, compare_url) = match primary.notes.as_deref() {
        Some(raw) => {
            let (body, compare) = split_changelog(raw);
            let notes = if body.is_empty() {
                // The commit fallback is a GitHub API call; skip it when GitHub
                // was unreachable and the mirror answered instead.
                if github_ok {
                    compare.as_deref().and_then(commit_notes)
                } else {
                    None
                }
            } else {
                Some(body)
            };
            (notes, compare)
        }
        None => (None, None),
    };

    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut github_assets: HashMap<String, (String, u64)> = HashMap::new();
    let mut gitee_assets: HashMap<String, (String, u64)> = HashMap::new();

    if let Some(release) = &github {
        for (name, url, size) in &release.assets {
            github_assets.insert(name.clone(), (url.clone(), *size));
            if seen.insert(name.clone()) {
                names.push(name.clone());
            }
        }
    }
    if let Some(release) = &gitee {
        for (name, url, size) in &release.assets {
            gitee_assets.insert(name.clone(), (url.clone(), *size));
            if seen.insert(name.clone()) {
                names.push(name.clone());
            }
        }
    }

    let prefix = cdn();
    let tag = primary.tag.clone();
    let mut assets: Vec<Value> = Vec::new();
    for name in names {
        let github_url = github_assets.get(&name).map(|(url, _)| url.clone());
        let gitee_url = gitee_assets.get(&name).map(|(url, _)| url.clone());
        let size = github_assets
            .get(&name)
            .map(|(_, size)| *size)
            .filter(|size| *size > 0)
            .or_else(|| gitee_assets.get(&name).map(|(_, size)| *size))
            .unwrap_or(0);

        // Domestic first: CDN → Gitee → GitHub. The UI tries them in order.
        let mut urls: Vec<String> = Vec::new();
        if !prefix.is_empty() {
            urls.push(format!("{prefix}/{tag}/{name}"));
        }
        if let Some(url) = &gitee_url {
            if !urls.contains(url) {
                urls.push(url.clone());
            }
        }
        if let Some(url) = &github_url {
            if !urls.contains(url) {
                urls.push(url.clone());
            }
        }
        if urls.is_empty() {
            continue;
        }

        assets.push(json!({
            "name": name,
            "url": urls[0],
            "urls": urls,
            "mirrorUrl": gitee_url,
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
        "url": primary.html_url,
        "releaseName": primary.name,
        "notes": notes,
        "compareUrl": compare_url,
        "publishedAt": primary.published,
        "assets": assets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_assets_become_gitee_download_urls() {
        let value = json!({
            "tag": "v0.1.5",
            "name": "Oriel v0.1.5",
            "notes": "hello",
            "publishedAt": "2026-01-01T00:00:00Z",
            "assets": [
                { "name": "Oriel_0.1.5_x64-setup.exe", "size": 123 },
                { "name": "Oriel_0.1.5_x64_en-US.msi", "size": 456 }
            ]
        });

        let release = manifest_from_value("rain-drops/oriel", &value).expect("manifest");
        assert_eq!(release.tag, "v0.1.5");
        assert_eq!(release.assets.len(), 2);
        assert_eq!(release.assets[0].0, "Oriel_0.1.5_x64-setup.exe");
        assert_eq!(release.assets[0].2, 123);
        assert_eq!(
            release.assets[0].1,
            "https://gitee.com/rain-drops/oriel/releases/download/v0.1.5/Oriel_0.1.5_x64-setup.exe"
        );
        assert_eq!(
            release.html_url.as_deref(),
            Some("https://gitee.com/rain-drops/oriel/releases/tag/v0.1.5")
        );
    }

    #[test]
    fn manifest_without_a_tag_is_ignored() {
        let value = json!({ "assets": [] });
        assert!(manifest_from_value("rain-drops/oriel", &value).is_none());
    }

    #[test]
    fn version_compare_ignores_the_v_prefix() {
        assert!(is_newer("v0.1.5", "0.1.4"));
        assert!(!is_newer("v0.1.4", "0.1.4"));
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("0.1.10", "0.1.9"));
    }
}
