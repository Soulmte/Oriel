//! Name search.
//!
//! The old service walked depth-first, `readdir`-ed each folder and then issued
//! one `lstat` per hit. This walker asks Windows for a whole directory in one
//! `FindFirstFileEx` call, fans the work out over a few threads, and streams the
//! first matches as soon as they are seen.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::entry::{enumerate, Entry};
use crate::paths::{join, root_of};

pub const SEARCH_RESULT_LIMIT: usize = 500;
pub const MAX_SCAN_ENTRIES: usize = 800_000;
pub const SEARCH_BUDGET: Duration = Duration::from_millis(10_000);

/// Folders that are never worth walking and usually deny access anyway.
const SKIP_NAMES: [&str; 4] = [
    "$recycle.bin",
    "system volume information",
    "$winreagent",
    "config.msi",
];

#[derive(Clone)]
pub struct SearchOptions {
    pub show_hidden: bool,
    pub limit: usize,
    pub budget: Duration,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            show_hidden: false,
            limit: SEARCH_RESULT_LIMIT,
            budget: SEARCH_BUDGET,
        }
    }
}

pub struct SearchSummary {
    pub entries: Vec<Entry>,
    pub scanned: usize,
    pub truncated: bool,
    pub timed_out: bool,
}

pub enum SearchEvent {
    Matches(Vec<Entry>),
    Progress(usize),
}

struct Matcher {
    ascii: bool,
    needles: Vec<String>,
}

impl Matcher {
    fn new(query: &str) -> Option<Self> {
        let needles: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .filter(|token| !token.is_empty())
            .map(|token| token.to_string())
            .collect();
        if needles.is_empty() {
            return None;
        }
        let ascii = needles.iter().all(|token| token.is_ascii());
        Some(Self { ascii, needles })
    }

    fn matches(&self, name: &str) -> bool {
        if self.ascii {
            self.needles
                .iter()
                .all(|needle| contains_ascii_ci(name, needle))
        } else {
            let lower = name.to_lowercase();
            self.needles.iter().all(|needle| lower.contains(needle.as_str()))
        }
    }

    /// True when at least one token appears in the folder path, which makes the
    /// path-based fallback below worth the allocation.
    fn touches_dir(&self, dir_lower: &str) -> bool {
        self.needles.len() > 1
            && self
                .needles
                .iter()
                .any(|needle| dir_lower.contains(needle.as_str()))
    }

    /// `2024 报告` should find `2024\报告.docx`: with two or more tokens the
    /// folder names may satisfy some of them, so match against the whole path.
    fn matches_path(&self, dir_lower: &str, name: &str) -> bool {
        let name_lower = name.to_lowercase();
        self.needles.iter().all(|needle| {
            dir_lower.contains(needle.as_str()) || name_lower.contains(needle.as_str())
        })
    }
}

fn contains_ascii_ci(haystack: &str, needle_lower: &str) -> bool {
    let hay = haystack.as_bytes();
    let needle = needle_lower.as_bytes();
    if needle.is_empty() {
        return true;
    }
    if needle.len() > hay.len() {
        return false;
    }
    'outer: for start in 0..=hay.len() - needle.len() {
        for offset in 0..needle.len() {
            let value = hay[start + offset];
            let folded = if value.is_ascii_uppercase() {
                value + 32
            } else {
                value
            };
            if folded != needle[offset] {
                continue 'outer;
            }
        }
        return true;
    }
    false
}

struct Shared {
    queue: Mutex<VecDeque<String>>,
    scanned: AtomicUsize,
    found: AtomicUsize,
    stop: AtomicBool,
    matcher: Matcher,
    root: String,
    show_hidden: bool,
    limit: usize,
    deadline: Instant,
    cancel: Option<Arc<AtomicBool>>,
}

impl Shared {
    fn should_stop(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
            || self.found.load(Ordering::Relaxed) >= self.limit
            || Instant::now() > self.deadline
            || self
                .cancel
                .as_ref()
                .map(|token| token.load(Ordering::Relaxed))
                .unwrap_or(false)
    }
}

/// Runs one search, streaming batches through `on_event`. Call it from a
/// blocking thread; it returns once every worker is done.
pub fn run_search(
    root: &str,
    query: &str,
    options: SearchOptions,
    cancel: Option<Arc<AtomicBool>>,
    mut on_event: impl FnMut(SearchEvent),
) -> SearchSummary {
    let matcher = match Matcher::new(query) {
        Some(matcher) => matcher,
        None => {
            return SearchSummary {
                entries: Vec::new(),
                scanned: 0,
                truncated: false,
                timed_out: false,
            }
        }
    };

    let deadline = Instant::now() + options.budget;
    let mut queue = VecDeque::new();
    queue.push_back(root.to_string());

    let shared = Arc::new(Shared {
        queue: Mutex::new(queue),
        scanned: AtomicUsize::new(0),
        found: AtomicUsize::new(0),
        stop: AtomicBool::new(false),
        matcher,
        root: root.to_string(),
        show_hidden: options.show_hidden,
        limit: options.limit.max(1),
        deadline,
        cancel,
    });

    let (sender, receiver) = mpsc::channel::<SearchEvent>();
    let workers = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .clamp(2, 8);

    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let shared = Arc::clone(&shared);
        let sender = sender.clone();
        handles.push(std::thread::spawn(move || worker(shared, sender)));
    }
    drop(sender);

    let mut entries: Vec<Entry> = Vec::new();
    for event in receiver {
        match event {
            SearchEvent::Matches(batch) => {
                let remaining = options.limit.max(1).saturating_sub(entries.len());
                if remaining == 0 {
                    continue;
                }
                let take: Vec<Entry> = batch.into_iter().take(remaining).collect();
                if take.is_empty() {
                    continue;
                }
                entries.extend(take.iter().cloned());
                on_event(SearchEvent::Matches(take));
            }
            SearchEvent::Progress(scanned) => on_event(SearchEvent::Progress(scanned)),
        }
    }

    for handle in handles {
        let _ = handle.join();
    }

    let scanned = shared.scanned.load(Ordering::Relaxed);
    let cancelled = shared
        .cancel
        .as_ref()
        .map(|token| token.load(Ordering::Relaxed))
        .unwrap_or(false);
    let timed_out = !cancelled && Instant::now() >= shared.deadline && entries.len() < options.limit;
    let truncated = cancelled || timed_out || entries.len() >= options.limit;

    SearchSummary {
        entries,
        scanned,
        truncated,
        timed_out,
    }
}

fn worker(shared: Arc<Shared>, sender: mpsc::Sender<SearchEvent>) {
    let mut batch: Vec<Entry> = Vec::new();
    let mut since_progress = 0usize;

    loop {
        if shared.should_stop() {
            break;
        }

        let next = {
            let mut queue = match shared.queue.lock() {
                Ok(queue) => queue,
                Err(_) => break,
            };
            queue.pop_front()
        };

        let directory = match next {
            Some(directory) => directory,
            None => break,
        };

        let raw = match enumerate(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        shared.scanned.fetch_add(raw.len(), Ordering::Relaxed);
        since_progress += raw.len();

        // Multi-token queries may match through the folder names, so the path is
        // lowercased once per directory instead of once per entry.
        let relative_dir = directory
            .strip_prefix(shared.root.as_str())
            .unwrap_or(&directory)
            .to_lowercase();
        let check_path = shared.matcher.touches_dir(&relative_dir);

        let mut subdirectories: Vec<String> = Vec::new();
        for item in &raw {
            if item.is_dir() && !item.is_link() {
                let lower = item.name.to_ascii_lowercase();
                if !SKIP_NAMES.contains(&lower.as_str()) {
                    subdirectories.push(join(&directory, &item.name));
                }
            }
            if item.is_hidden() && !shared.show_hidden {
                continue;
            }
            if !shared.matcher.matches(&item.name)
                && !(check_path && shared.matcher.matches_path(&relative_dir, &item.name))
            {
                continue;
            }
            let next = shared.found.fetch_add(1, Ordering::Relaxed) + 1;
            if next > shared.limit {
                shared.stop.store(true, Ordering::Relaxed);
                break;
            }
            batch.push(item.to_entry(&directory));
            if batch.len() >= 16 {
                let _ = sender.send(SearchEvent::Matches(std::mem::take(&mut batch)));
            }
        }

        if !subdirectories.is_empty() {
            if let Ok(mut queue) = shared.queue.lock() {
                queue.extend(subdirectories);
            }
        }

        if since_progress >= 1_500 {
            since_progress = 0;
            let _ = sender.send(SearchEvent::Progress(shared.scanned.load(Ordering::Relaxed)));
        }

        if shared.scanned.load(Ordering::Relaxed) >= MAX_SCAN_ENTRIES {
            shared.stop.store(true, Ordering::Relaxed);
            break;
        }
    }

    if !batch.is_empty() {
        let _ = sender.send(SearchEvent::Matches(batch));
    }
    let _ = sender.send(SearchEvent::Progress(shared.scanned.load(Ordering::Relaxed)));
}

/// One-shot search used by the non-streaming route.
pub fn search(root: &str, query: &str, options: SearchOptions) -> SearchSummary {
    run_search(root, query, options, None, |_| {})
}

/// Widens a folder search to the volume root, matching the `disk` scope.
pub fn disk_root_for(target: &str) -> String {
    root_of(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_matching_is_case_insensitive() {
        assert!(contains_ascii_ci("Annual-Report.PDF", "report"));
        assert!(contains_ascii_ci("照片", ""));
        assert!(!contains_ascii_ci("abc", "abcd"));
    }

    #[test]
    fn tokens_all_have_to_match() {
        let matcher = Matcher::new("report 2024").unwrap();
        assert!(matcher.matches("2024-annual-report.pdf"));
        assert!(!matcher.matches("2024-annual.pdf"));
    }

    #[test]
    fn multi_token_queries_match_through_folder_names() {
        let matcher = Matcher::new("2024 报告").unwrap();
        // The name alone is not enough…
        assert!(!matcher.matches("报告.docx"));
        // …but the folder it lives in satisfies the other token.
        assert!(matcher.touches_dir(r"\archive\2024"));
        assert!(matcher.matches_path(r"\archive\2024", "报告.docx"));
        // A folder unrelated to the query keeps the fast path.
        assert!(!matcher.touches_dir(r"\archive\2023"));
    }

    #[test]
    fn single_token_queries_never_use_the_path_fallback() {
        let matcher = Matcher::new("报告").unwrap();
        assert!(!matcher.touches_dir(r"\archive\2024"));
    }
}
