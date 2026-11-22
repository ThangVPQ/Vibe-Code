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

/// A row of the File Explorer tab: everything in the folder (hidden / system items flagged, not dropped).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// ms since 1970; 0 unknown
    modified: f64,
    hidden: bool,
}

#[tauri::command]
pub async fn fs_explore(dir: String) -> Res<Vec<ExEntry>> {
    Ok(tokio::task::spawn_blocking(move || -> std::io::Result<Vec<ExEntry>> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(&dir)?.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            // links and junctions: what they point at decides folder or file
            let is_dir = if meta.file_type().is_symlink() { std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false) } else { meta.is_dir() };
            let name = e.file_name().to_string_lossy().into_owned();
            #[cfg(windows)]
            let hidden = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x6 != 0 // HIDDEN | SYSTEM
            };
            #[cfg(not(windows))]
            let hidden = name.starts_with('.');
            let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_millis() as f64);
            out.push(ExEntry { path: e.path().to_string_lossy().into_owned(), name, is_dir, size: if is_dir { 0 } else { meta.len() }, modified, hidden });
        }
        Ok(out)
    })
    .await??)
}

/// The File Explorer's left column: the user's folders and the drives.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    /// home, desktop, documents, downloads, pictures, videos, music, drive
    kind: &'static str,
    name: String,
    path: String,
    /// drives: bytes, 0 unknown
    total: u64,
    free: u64,
}

#[tauri::command]
pub async fn fs_places() -> Res<Vec<Place>> {
    Ok(tokio::task::spawn_blocking(|| {
        let mut out = Vec::new();
        let folders: [(&'static str, &str, Option<PathBuf>); 7] = [
            ("home", "Home", dirs::home_dir()),
            ("desktop", "Desktop", dirs::desktop_dir()),
            ("documents", "Documents", dirs::document_dir()),
            ("downloads", "Downloads", dirs::download_dir()),
            ("pictures", "Pictures", dirs::picture_dir()),
            ("videos", "Videos", dirs::video_dir()),
            ("music", "Music", dirs::audio_dir()),
        ];
        for (kind, name, path) in folders {
            if let Some(p) = path.filter(|p| p.is_dir()) {
                out.push(Place { kind, name: name.to_owned(), path: p.to_string_lossy().into_owned(), total: 0, free: 0 });
            }
        }
        out.extend(drives());
        out
    })
    .await?)
}

#[cfg(windows)]
fn drives() -> Vec<Place> {
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
    use windows::core::HSTRING;
    const REMOVABLE: u32 = 2;
    const REMOTE: u32 = 4;
    const CDROM: u32 = 5;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u8 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i) as char;
        let root = format!("{letter}:\\");
        let h = HSTRING::from(root.as_str());
        let kind = unsafe { GetDriveTypeW(&h) };
        let mut label = [0u16; 261];
        let mut total = 0u64;
        let mut free = 0u64;
        // network drives can hang when the server is gone: name only
        let mounted = kind != REMOTE
            && unsafe { GetVolumeInformationW(&h, Some(&mut label), None, None, None, None) }.is_ok();
        if mounted {
            let _ = unsafe { GetDiskFreeSpaceExW(&h, None, Some(&mut total), Some(&mut free)) };
        } else if kind == CDROM || kind == REMOVABLE {
            continue; // an empty card reader / disc drive
        }
        let label = String::from_utf16_lossy(&label[..label.iter().position(|&c| c == 0).unwrap_or(0)]);
        let label = if !label.is_empty() {
            label
        } else {
            match kind {
                REMOVABLE => "USB Drive".into(),
                REMOTE => "Network Drive".into(),
                CDROM => "CD Drive".into(),
                _ => "Local Disk".into(),
            }
        };
        out.push(Place { kind: "drive", name: format!("{label} ({letter}:)"), path: root, total, free });
    }
    out
}

#[cfg(not(windows))]
fn drives() -> Vec<Place> {
    vec![Place { kind: "drive", name: "/".into(), path: "/".into(), total: 0, free: 0 }]
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

/// Inside a git directory, only what changes the Changes panel or the history: the branch, refs,
/// the index (staging). `rest` is the path below the git directory.
fn git_relevant(rest: &[&std::ffi::OsStr], p: &Path) -> bool {
    let keep = match rest.first().and_then(|s| s.to_str()) {
        Some("HEAD" | "index" | "packed-refs" | "MERGE_HEAD") => rest.len() == 1,
        Some("refs") => true,
        None => true,
        _ => false,
    };
    keep && !p.extension().is_some_and(|e| e == "lock")
}

enum Seen {
    Skip,
    File,
    Git,
}

/// `p` relative to the watched root (a project that itself lives under e.g. `D:\build` still
/// counts). `git_dir`: the repository's git directory when it is outside the root (the folder
/// opened is inside a bigger repo, or is a worktree).
fn classify(root: &Path, git_dir: Option<&Path>, p: &Path) -> Seen {
    if let Some(g) = git_dir
        && let Ok(rest) = p.strip_prefix(g)
    {
        let parts: Vec<&std::ffi::OsStr> = rest.components().map(|c| c.as_os_str()).collect();
        return if git_relevant(&parts, p) { Seen::Git } else { Seen::Skip };
    }
    let rel = p.strip_prefix(root).unwrap_or(p);
    let parts: Vec<&std::ffi::OsStr> = rel.components().map(|c| c.as_os_str()).collect();
    if let Some(i) = parts.iter().position(|s| *s == ".git") {
        return if git_relevant(&parts[i + 1..], p) { Seen::Git } else { Seen::Skip };
    }
    if parts.iter().any(|s| SKIP_WATCH.iter().any(|k| *s == *k)) { Seen::Skip } else { Seen::File }
}

/// The repository's git directory when it is not `<root>/.git` (opened a subfolder of a repo, or a
/// worktree): a commit only touches that directory, so it has to be watched as well.
async fn outside_git_dir(root: &Path) -> Option<PathBuf> {
    let out = crate::core::command("git").args(["rev-parse", "--absolute-git-dir"]).current_dir(root).output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let dir = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().replace('/', std::path::MAIN_SEPARATOR_STR));
    let lower = |p: &Path| p.to_string_lossy().to_lowercase();
    (!lower(&dir).starts_with(&lower(root))).then_some(dir)
}

#[tauri::command]
pub async fn fs_watch(root: Option<String>) -> Res<()> {
    let Some(root) = root else {
        *WATCHER.lock() = None; // drops (stops) the previous watcher
        return Ok(());
    };
    let base = PathBuf::from(&root);
    let git_dir = outside_git_dir(&base).await;
    let mut slot = WATCHER.lock();
    *slot = None;
    let gd = git_dir.clone();
    let mut deb = new_debouncer(Duration::from_millis(200), None, move |res: DebounceEventResult| {
        // lost events (overflow while several chats write at once): report the root, so the Changes
        // panel and the history still refresh instead of waiting for the next change
        let lost = || {
            emit("fs:changed", (vec![base.to_string_lossy().into_owned()],));
            emit("git:changed", ((),)); // payload is the listener's argument list
        };
        let Ok(events) = res else { return lost() };
        if events.iter().any(|e| e.need_rescan()) {
            return lost();
        }
        let mut git = false;
        let mut paths: Vec<String> = Vec::new();
        for p in events.iter().flat_map(|e| e.paths.iter()) {
            match classify(&base, gd.as_deref(), p) {
                Seen::Skip => {}
                Seen::Git => git = true,
                Seen::File => paths.push(p.to_string_lossy().into_owned()),
            }
        }
        paths.sort_unstable();
        paths.dedup();
        if !paths.is_empty() {
            emit("fs:changed", (paths,));
        }
        // a commit, checkout, pull or staging: only the git directory changes
        if git {
            emit("git:changed", ((),)); // payload is the listener's argument list
        }
    })?;
    deb.watch(PathBuf::from(&root), RecursiveMode::Recursive)?;
    if let Some(g) = git_dir {
        // best effort: the panel still refreshes on the project's own file changes without it
        let _ = deb.watch(&g, RecursiveMode::Recursive);
    }
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

/// Rename or move; refuses to overwrite.
#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Res<()> {
    if tokio::fs::try_exists(&to).await? {
        return Err(crate::core::err(format!("{to} already exists")));
    }
    tokio::fs::rename(from, to).await?;
    Ok(())
}

/// Copy a file or folder into `dir`, as "name copy.ext" (2, 3…) when the name is taken. Returns the new path.
#[tauri::command]
pub async fn fs_copy(from: String, dir: String) -> Res<String> {
    tokio::task::spawn_blocking(move || {
        let src = Path::new(&from);
        let name = src.file_name().ok_or_else(|| crate::core::err("nothing to copy"))?.to_string_lossy().into_owned();
        let (stem, ext) = match name.rfind('.') {
            Some(i) if i > 0 && src.is_file() => (name[..i].to_owned(), name[i..].to_owned()),
            _ => (name.clone(), String::new()),
        };
        let mut dst = Path::new(&dir).join(&name);
        let mut n = 1;
        while dst.exists() {
            let suffix = if n == 1 { " copy".to_owned() } else { format!(" copy {n}") };
            dst = Path::new(&dir).join(format!("{stem}{suffix}{ext}"));
            n += 1;
        }
        if dst.starts_with(src) {
            return Err(crate::core::err("can't copy a folder into itself"));
        }
        copy_tree(src, &dst)?;
        Ok(dst.to_string_lossy().into_owned())
    })
    .await?
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir(dst)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_tree(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(drop)
    }
}

/// Send a file or folder to the Recycle Bin (it can be restored from there).
pub async fn trash(path: &Path) -> Res<()> {
    // the path goes through the environment, never into the script text
    let out = crate::core::command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:VIBE_TRASH; \
             if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } \
             else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
        ])
        .env("VIBE_TRASH", path)
        .output()
        .await?;
    if !out.status.success() {
        return Err(crate::core::err(String::from_utf8_lossy(&out.stderr).trim().to_owned()));
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_trash(path: String) -> Res<()> {
    trash(Path::new(&path)).await
}

/// New empty file (or folder); refuses to overwrite.
#[tauri::command]
pub async fn fs_create(path: String, dir: bool) -> Res<()> {
    if tokio::fs::try_exists(&path).await? {
        return Err(crate::core::err(format!("{path} already exists")));
    }
    if dir {
        tokio::fs::create_dir(&path).await?;
    } else {
        tokio::fs::write(&path, "").await?;
    }
    Ok(())
}
