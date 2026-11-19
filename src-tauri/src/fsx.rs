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

fn ignored(p: &Path) -> bool {
    let mut prev_git = false;
    for c in p.components() {
        let s = c.as_os_str();
        if s == "node_modules" || s == "out" || s == "dist" || (prev_git && s == "objects") {
            return true;
        }
        prev_git = s == ".git";
    }
    false
}

#[tauri::command]
pub async fn fs_watch(root: Option<String>) -> Res<()> {
    let mut slot = WATCHER.lock();
    *slot = None; // drops (stops) the previous watcher
    let Some(root) = root else { return Ok(()) };
    let mut deb = new_debouncer(Duration::from_millis(200), None, |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<String> = events
            .iter()
            .flat_map(|e| e.paths.iter())
            .filter(|p| !ignored(p))
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
