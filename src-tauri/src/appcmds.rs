//! Small app-level commands: settings, pickers, attachments, Claude's usage and per-project bypass.

use std::path::Path;

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

use crate::{
    core::{Res, app, err, home, now_ms},
    settings::{self, AppSettings},
};

/* ---------------- Claude ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    kind: String,
    label: String,
    percent: i64,
    severity: String,
    resets_at: Option<String>,
}

/// Same numbers as Claude Code's /usage, read with the OAuth login `claude` keeps in
/// ~/.claude/.credentials.json. Read-only: we never refresh the token (Claude Code does).
#[tauri::command]
pub async fn claude_usage() -> Res<Option<Vec<UsageLimit>>> {
    Ok(fetch_usage().await.ok())
}

async fn fetch_usage() -> anyhow::Result<Vec<UsageLimit>> {
    let raw = tokio::fs::read(home().join(".claude").join(".credentials.json")).await?;
    let creds: Value = serde_json::from_slice(&raw)?;
    let token = creds.pointer("/claudeAiOauth/accessToken").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("no token"))?;
    let j: Value = reqwest::Client::new()
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let limits = j.get("limits").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(limits
        .iter()
        .map(|l| {
            let kind = l["kind"].as_str().unwrap_or_default().to_owned();
            let label = match kind.as_str() {
                "session" => "5-hour".to_owned(),
                "weekly_all" => "Weekly".to_owned(),
                _ => format!("Weekly · {}", l.pointer("/scope/model/display_name").and_then(Value::as_str).unwrap_or("model")),
            };
            UsageLimit {
                kind,
                label,
                percent: l["percent"].as_f64().unwrap_or(0.0).round() as i64,
                severity: l["severity"].as_str().unwrap_or_default().to_owned(),
                resets_at: l["resets_at"].as_str().map(str::to_owned),
            }
        })
        .collect())
}

/// <project>/.claude/settings.local.json — {} when missing; an error when present but not JSON.
async fn read_project_local(folder: &str) -> anyhow::Result<Map<String, Value>> {
    let Ok(raw) = tokio::fs::read_to_string(Path::new(folder).join(".claude").join("settings.local.json")).await else {
        return Ok(Map::new());
    };
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    Ok(serde_json::from_str(&raw)?)
}

#[tauri::command]
pub async fn claude_get_project_bypass(folder: String) -> Res<bool> {
    let s = read_project_local(&folder).await.unwrap_or_default();
    Ok(s.get("permissions").and_then(|p| p.get("defaultMode")).and_then(Value::as_str) == Some("bypassPermissions"))
}

/// Claude Code's own per-project setting `permissions.defaultMode`.
#[tauri::command]
pub async fn claude_set_project_bypass(folder: String, on: bool) -> Res<bool> {
    // never overwrite a file we can't parse — that would wipe the user's settings
    let mut s = read_project_local(&folder).await?;
    let mut perms = s.get("permissions").and_then(Value::as_object).cloned().unwrap_or_default();
    if on {
        perms.insert("defaultMode".into(), json!("bypassPermissions"));
    } else if perms.get("defaultMode").and_then(Value::as_str) == Some("bypassPermissions") {
        perms.remove("defaultMode");
    }
    if perms.is_empty() {
        s.remove("permissions");
    } else {
        s.insert("permissions".into(), Value::Object(perms));
    }
    let dir = Path::new(&folder).join(".claude");
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(dir.join("settings.local.json"), serde_json::to_string_pretty(&s)? + "\n").await?;
    Ok(on)
}

/* ---------------- system memory ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemInfo {
    used_bytes: u64,
    total_bytes: u64,
}

/// Physical RAM in use across the whole machine (what Task Manager's Memory shows).
#[tauri::command]
pub fn sys_memory() -> Option<MemInfo> {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        // SAFETY: plain out-param struct with dwLength set as the API requires.
        unsafe { GlobalMemoryStatusEx(&mut m) }.ok()?;
        Some(MemInfo { used_bytes: m.ullTotalPhys - m.ullAvailPhys, total_bytes: m.ullTotalPhys })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/* ---------------- settings ---------------- */

#[tauri::command]
pub async fn app_settings() -> Res<AppSettings> {
    Ok(settings::get())
}

#[tauri::command]
pub async fn app_remember_folder(folder: String) -> Res<AppSettings> {
    Ok(settings::remember_folder(folder).await)
}

#[tauri::command]
pub async fn app_set_settings(patch: Map<String, Value>) -> Res<AppSettings> {
    const ALLOWED: [&str; 10] = ["theme", "dropOpacity", "dropHeight", "hideOnBlur", "model", "effort", "permissionMode", "seeThrough", "adBlock", "language"];
    let clean: Map<String, Value> = patch.into_iter().filter(|(k, _)| ALLOWED.contains(&k.as_str())).collect();
    let drop_prefs = ["dropOpacity", "dropHeight", "hideOnBlur", "language"].iter().any(|k| clean.contains_key(*k));
    let ad_block = clean.contains_key("adBlock");
    let s = settings::update(clean).await;
    // the tray menu is rebuilt there too, so a new language shows up in it
    if drop_prefs {
        crate::windowing::apply_drop_prefs();
    }
    if ad_block {
        crate::browser::sync_adblock();
    }
    Ok(s)
}

/* ---------------- pickers + attachments ---------------- */

#[tauri::command]
pub async fn app_pick_folder() -> Res<Option<String>> {
    let mut d = app().dialog().file();
    if let Some(w) = crate::core::main_window() {
        d = d.set_parent(&w);
    }
    let picked = tokio::task::spawn_blocking(move || d.blocking_pick_folder()).await?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

/// Chat "Attach files": Claude Code reads files by path, so only the chosen paths come back.
#[tauri::command]
pub async fn app_pick_files(default_path: Option<String>) -> Res<Vec<String>> {
    let mut d = app().dialog().file().set_title(settings::tr("Attach files to the chat", "Đính kèm tệp vào chat"));
    if let Some(p) = default_path.filter(|p| !p.is_empty()) {
        d = d.set_directory(p);
    }
    if let Some(w) = crate::core::main_window() {
        d = d.set_parent(&w);
    }
    let picked = tokio::task::spawn_blocking(move || d.blocking_pick_files()).await?;
    Ok(picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect())
}

#[derive(Serialize)]
pub struct FileInfo {
    path: String,
    size: i64,
    dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
}

fn image_mime(p: &str) -> Option<&'static str> {
    let ext = p.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Attachment tray: size, folder?, and an image's picture (≤ 15 MB) as a data: URL.
#[tauri::command]
pub async fn app_file_info(paths: Vec<String>) -> Res<Vec<FileInfo>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let Ok(meta) = tokio::fs::metadata(&path).await else {
            out.push(FileInfo { path, size: -1, dir: false, preview: None });
            continue;
        };
        let mut preview = None;
        if meta.is_file()
            && meta.len() <= 15 * 1024 * 1024
            && let Some(mime) = image_mime(&path)
            && let Ok(bytes) = tokio::fs::read(&path).await
        {
            preview = Some(format!("data:{mime};base64,{}", B64.encode(bytes)));
        }
        out.push(FileInfo { size: if meta.is_file() { meta.len() as i64 } else { -1 }, dir: meta.is_dir(), path, preview });
    }
    Ok(out)
}

#[tauri::command]
pub async fn app_open_external(url: String) -> Res<()> {
    if url.starts_with("http://") || url.starts_with("https://") {
        tauri_plugin_opener::open_url(url, None::<&str>)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn app_clear_browser_cache() -> Res<()> {
    crate::browser::clear_cache().await
}

#[tauri::command]
pub async fn app_relaunch() -> Res<bool> {
    if cfg!(debug_assertions) {
        // `tauri dev` owns the process: the user restarts it by hand
        return Ok(false);
    }
    crate::pty::kill_all();
    app().restart();
}

/* ---------------- updates (GitHub releases) ---------------- */

const RELEASES: &str = "https://api.github.com/repos/ThangVPQ/Vibe-Code/releases/latest";

/// The newest release's version, installer url and notes, when it is newer than this build.
async fn newer_release() -> anyhow::Result<Option<(String, String, String)>> {
    let r = reqwest::Client::new()
        .get(RELEASES)
        .header("User-Agent", "vibe-code")
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?;
    if r.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None); // no release yet
    }
    let j: Value = r.error_for_status()?.json().await?;
    let latest = j["tag_name"].as_str().unwrap_or_default().trim_start_matches('v').to_owned();
    let parse = |v: &str| v.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    if parse(&latest) <= parse(&app().package_info().version.to_string()) {
        return Ok(None);
    }
    let url = j["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with("-setup.exe")))
        .and_then(|a| a["browser_download_url"].as_str());
    let notes = j["body"].as_str().unwrap_or_default().trim().to_owned();
    Ok(url.map(|u| (latest, u.to_owned(), notes)))
}

/// The newer version on GitHub and its release notes, or None when this build is the latest.
#[tauri::command]
pub async fn app_check_update() -> Res<Option<Value>> {
    Ok(newer_release().await?.map(|(version, _, notes)| json!({ "version": version, "notes": notes })))
}

/// Downloads the newest installer, runs it in passive update mode (it restarts the app) and quits.
#[tauri::command]
pub async fn app_install_update() -> Res<()> {
    let (version, url, _) = newer_release().await?.ok_or_else(|| err(settings::tr("already up to date", "đã là bản mới nhất")))?;
    let bytes = reqwest::Client::new().get(&url).header("User-Agent", "vibe-code").send().await?.error_for_status()?.bytes().await?;
    let path = std::env::temp_dir().join(format!("vibe-code_{version}_setup.exe"));
    tokio::fs::write(&path, &bytes).await?;
    std::process::Command::new(&path).args(["/P", "/R", "/UPDATE"]).spawn()?;
    crate::pty::kill_all();
    app().exit(0);
    Ok(())
}

/// Pasted / dropped image bytes (raw request body, extension in `x-ext`) → a temp file path.
#[tauri::command]
pub async fn app_save_image(request: Request<'_>) -> Res<String> {
    let InvokeBody::Raw(data) = request.body() else { return Err(err("expected raw image bytes")) };
    let ext = request.headers().get("x-ext").and_then(|v| v.to_str().ok()).unwrap_or("png");
    let ext = if !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) { ext } else { "png" };
    let dir = std::env::temp_dir().join("tinjs-paste");
    tokio::fs::create_dir_all(&dir).await?;
    let file = dir.join(format!("image-{}.{ext}", now_ms()));
    tokio::fs::write(&file, data).await?;
    Ok(file.to_string_lossy().into_owned())
}

/// Files copied in Explorer (CF_HDROP): a WebView only sees their bytes, never their paths.
#[tauri::command]
pub async fn app_clipboard_files() -> Res<Vec<String>> {
    Ok(tokio::task::spawn_blocking(clipboard_files).await?)
}

#[cfg(windows)]
fn clipboard_files() -> Vec<String> {
    use windows::Win32::{
        Foundation::HANDLE,
        System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard},
        UI::Shell::{DragQueryFileW, HDROP},
    };
    const CF_HDROP: u32 = 15;
    let mut out = Vec::new();
    // SAFETY: plain Win32 clipboard calls; the clipboard is closed on every path after opening.
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP).is_err() || OpenClipboard(None).is_err() {
            return out;
        }
        if let Ok(HANDLE(h)) = GetClipboardData(CF_HDROP) {
            let drop = HDROP(h);
            let n = DragQueryFileW(drop, u32::MAX, None);
            for i in 0..n {
                let len = DragQueryFileW(drop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(drop, i, Some(&mut buf));
                out.push(String::from_utf16_lossy(&buf[..len]));
            }
        }
        let _ = CloseClipboard();
    }
    out
}

#[cfg(not(windows))]
fn clipboard_files() -> Vec<String> {
    Vec::new()
}

/// Windows voice typing (Win+H): it types what you say into the focused field.
#[tauri::command]
pub fn app_voice_typing() {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY};
        let key = |vk: u16, flags: KEYBD_EVENT_FLAGS| INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
        let none = KEYBD_EVENT_FLAGS(0);
        let inputs = [key(0x5B, none), key(0x48, none), key(0x48, KEYEVENTF_KEYUP), key(0x5B, KEYEVENTF_KEYUP)];
        // SAFETY: a slice of fully initialised INPUTs.
        unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    }
}
