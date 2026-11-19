//! Files for the explorer, quick-open and editor, and the project watcher.

use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use parking_lot::Mutex;
use serde::Serialize;

use crate::core::{Res, emit};

const HIDDEN: [&str; 4] = [".git", "node_modules", ".DS_Store", "Thumbs.db"];
const SKIP_WALK: [&str; 12] = [".git", "node_modules", "out", "dist", "build", ".next", ".venv", "venv", "__pycache__", "bin", "obj", ".vs"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
pub async fn fs_read_dir(dir: String) -> Res<Vec<DirEntry>> {
    let mut rd = tokio::fs::read_dir(&dir).await?;
    let mut out = Vec::new();
    while let Some(e) = rd.next_entry().await? {
        let name = e.file_name().to_string_lossy().into_owned();
        if HIDDEN.contains(&name.as_str()) {
            continue;
        }
        let is_dir = e.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry { path: e.path().to_string_lossy().into_owned(), name, is_dir });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    content: String,
    binary: bool,
    too_large: bool,
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Res<FileContent> {
    let meta = tokio::fs::metadata(&path).await?;
    if meta.len() > 8 * 1024 * 1024 {
        return Ok(FileContent { content: String::new(), binary: false, too_large: true });
    }
    let buf = tokio::fs::read(&path).await?;
    if buf[..buf.len().min(8000)].contains(&0) {
        return Ok(FileContent { content: String::new(), binary: true, too_large: false });
    }
    let content = String::from_utf8(buf).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok(FileContent { content, binary: false, too_large: false })
}

#[tauri::command]
pub async fn fs_write_file(path: String, content: String) -> Res<()> {
    tokio::fs::write(path, content).await?;
    Ok(())
}

/// Flat list of files (relative, forward slashes) for quick-open.
#[tauri::command]
pub async fn fs_list_files(root: String) -> Res<Vec<String>> {
    Ok(tokio::task::spawn_blocking(move || list_files(Path::new(&root), 20_000)).await?)
}

fn list_files(root: &Path, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut subdirs = Vec::new();
        for e in rd.flatten() {
            if out.len() >= limit {
                return out;
            }
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name();
            if ft.is_dir() {
                if !SKIP_WALK.iter().any(|s| name == *s) {
                    subdirs.push(e.path());
                }
            } else if let Ok(rel) = e.path().strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
        // depth-first in directory order, like the old recursive walk
        stack.extend(subdirs.into_iter().rev());
    }
    out
}

/* ---------------- watcher ---------------- */

static WATCHER: LazyLock<Mutex<Option<Debouncer<notify::RecommendedWatcher, RecommendedCache>>>> = LazyLock::new(|| Mutex::new(None));

/// Folders whose churn (build output, caches) means nothing to the explorer or the Changes panel.
/// A `cargo build` / `dotnet build` / `next dev` writes thousands of files there; each batch used to
/// re-run `git status` and re-read the open explorer folders.
const SKIP_WATCH: [&str; 18] = [
    "node_modules", "out", "dist", "build", "target", "bin", "obj", ".vs", ".next", ".nuxt", ".turbo", ".angular",
    ".svelte-kit", ".parcel-cache", ".gradle", "__pycache__", ".venv", "venv",
];

/// `p` relative to the watched root (a project that itself lives under e.g. `D:uild` still counts).
fn ignored(root: &Path, p: &Path) -> bool {
    let rel = p.strip_prefix(root).unwrap_or(p);
    let parts: Vec<&std::ffi::OsStr> = rel.components().map(|c| c.as_os_str()).collect();
    if let Some(i) = parts.iter().position(|s| *s == ".git") {
        // inside .git only what changes the Changes panel: the branch, refs, the index (staging)
        let rest = &parts[i + 1..];
        let keep = match rest.first().and_then(|s| s.to_str()) {
            Some("HEAD" | "index" | "packed-refs" | "MERGE_HEAD") => rest.len() == 1,
            Some("refs") => true,
            None => true,
            _ => false,
        };
        return !keep || p.extension().is_some_and(|e| e == "lock");
    }
    parts.iter().any(|s| SKIP_WATCH.iter().any(|k| *s == *k))
}

#[tauri::command]
pub async fn fs_watch(root: Option<String>) -> Res<()> {
    let mut slot = WATCHER.lock();
    *slot = None; // drops (stops) the previous watcher
    let Some(root) = root else { return Ok(()) };
    let base = PathBuf::from(&root);
    let mut deb = new_debouncer(Duration::from_millis(200), None, move |res: DebounceEventResult| {
        // lost events (overflow while several chats write at once): report the root, so the Changes
        // panel still refreshes instead of waiting for the next change
        let lost = || emit("fs:changed", (vec![base.to_string_lossy().into_owned()],));
        let Ok(events) = res else { return lost() };
        if events.iter().any(|e| e.need_rescan()) {
            return lost();
        }
        let mut paths: Vec<String> = events
            .iter()
            .flat_map(|e| e.paths.iter())
            .filter(|p| !ignored(&base, p))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        paths.sort_unstable();
        paths.dedup();
        if !paths.is_empty() {
            emit("fs:changed", (paths,));
        }
    })?;
    deb.watch(PathBuf::from(root), RecursiveMode::Recursive)?;
    *slot = Some(deb);
    Ok(())
}

#[tauri::command]
pub async fn fs_reveal(path: String) -> Res<()> {
    tauri_plugin_opener::reveal_item_in_dir(path)?;
    Ok(())
}

/// Opens a file / folder with the OS default handler; '' on success, else the error (like Electron).
#[tauri::command]
pub async fn fs_open_path(path: String) -> Res<String> {
    Ok(match tauri_plugin_opener::open_path(path, None::<&str>) {
        Ok(()) => String::new(),
        Err(e) => e.to_string(),
    })
}
