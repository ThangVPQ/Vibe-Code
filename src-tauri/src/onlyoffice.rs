//! Office tab → ONLYOFFICE: the full ONLYOFFICE editors (Word, Excel, PowerPoint — docx, xlsx, pptx,
//! the old doc/xls/ppt and OpenDocument), running inside the app with nothing installed on the machine.
//!
//! The editor is the open-source build of github.com/ranuts/document (AGPL-3.0): ONLYOFFICE's web
//! editors with its x2t file converter compiled to WebAssembly, so files are opened and saved in the
//! page, without a document server. It is downloaded once, on first use, from the project's published
//! container image (the one layer holding the built site), pinned by digest, and checked against it.
//!
//! The files are served from 127.0.0.1 to an iframe of the Office tab, which drives the editor with
//! the project's embed API (postMessage) and reads / writes the files through `office_*` commands.
//! Every response forbids the page any connection off this machine: no analytics, no AI services,
//! no downloads, no update checks — documents never leave the computer.

use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, bail};
use axum::{
    Router,
    extract::Path as UrlPath,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OnceCell};

use crate::core::{Res, emit, user_data};

/// ghcr.io/ranuts/document:0.0.9 (linux/amd64): its third layer is the site, under `public/`.
const IMAGE: &str = "ranuts/document";
const VERSION: &str = "0.0.9";
const LAYER: &str = "sha256:0962b06bf39191ddc50a09e40cff78573befe6e6b0ec5d6f797df0bfdf824958";
const LAYER_SIZE: u64 = 217_175_624;
/// Fixed so the editor's own settings (language, zoom, theme) stay with its origin between launches.
const PORT: u16 = 47391;
/// Sent with every file: the page may connect to this server and nothing else.
const CSP: &str = "connect-src 'self' blob: data:";

fn root() -> PathBuf {
    user_data().join("onlyoffice")
}

fn site() -> PathBuf {
    root().join(VERSION)
}

fn installed() -> bool {
    site().join("editor.html").is_file()
}

/* ---------------- commands ---------------- */

/// Where the editor is served (`http://127.0.0.1:<port>`), or null while it is not downloaded yet.
#[tauri::command]
pub async fn onlyoffice_origin() -> Res<Option<String>> {
    if !installed() {
        return Ok(None);
    }
    Ok(Some(origin().await?))
}

/// Downloads and unpacks the editor (once; `onlyoffice:progress` (bytes done, total) meanwhile)
/// and returns where it is served.
#[tauri::command]
pub async fn onlyoffice_install() -> Res<String> {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::const_new(());
    let _guard = ONE_AT_A_TIME.lock().await;
    if !installed() {
        install().await.context("không tải được ONLYOFFICE")?;
    }
    Ok(origin().await?)
}

/// Size of the one-time download, for the page to say before it starts.
#[tauri::command]
pub fn onlyoffice_download_size() -> u64 {
    LAYER_SIZE
}

/* ---------------- download ---------------- */

async fn install() -> Result<()> {
    let root = root();
    tokio::fs::create_dir_all(&root).await?;
    let tgz = root.join(format!("{VERSION}.tgz.part"));
    download(&tgz, |done| emit("onlyoffice:progress", (done, LAYER_SIZE))).await?;

    let staging = root.join(format!("{VERSION}.part"));
    let to = staging.clone();
    let from = tgz.clone();
    let unpacked = tokio::task::spawn_blocking(move || -> Result<()> {
        let _ = std::fs::remove_dir_all(&to);
        unpack(&from, &to)?;
        prepare(&to)
    })
    .await?;
    let _ = tokio::fs::remove_file(&tgz).await;
    if let Err(e) = unpacked {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(e);
    }
    tokio::fs::rename(&staging, site()).await?;
    // other versions, and leftovers of an interrupted download
    for d in std::fs::read_dir(&root)?.flatten() {
        if d.file_name() != VERSION {
            let p = d.path();
            let _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
        }
    }
    Ok(())
}

/// The image layer into `to`, checked against its digest; `progress` gets the bytes done so far.
async fn download(to: &Path, progress: impl Fn(u64)) -> Result<()> {
    use futures_util::StreamExt;
    let http = reqwest::Client::builder().user_agent("vibe-code").connect_timeout(std::time::Duration::from_secs(20)).read_timeout(std::time::Duration::from_secs(60)).build()?;
    // anonymous pull token of a public package
    let auth: Value = http.get(format!("https://ghcr.io/token?scope=repository:{IMAGE}:pull")).send().await?.error_for_status()?.json().await?;
    let token = auth["token"].as_str().context("ghcr.io gave no token")?;
    let res = http.get(format!("https://ghcr.io/v2/{IMAGE}/blobs/{LAYER}")).bearer_auth(token).send().await?.error_for_status()?;

    let mut file = std::fs::File::create(to)?;
    let mut hash = Sha256::new();
    let (mut done, mut shown) = (0u64, 0u64);
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        hash.update(&chunk);
        done += chunk.len() as u64;
        if done - shown >= LAYER_SIZE / 200 || done == LAYER_SIZE {
            shown = done;
            progress(done);
        }
    }
    file.sync_all()?;
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if done != LAYER_SIZE || format!("sha256:{got}") != LAYER {
        let _ = std::fs::remove_file(to);
        bail!("bản tải về bị hỏng ({done} / {LAYER_SIZE} byte), hãy thử lại");
    }
    Ok(())
}

/// The layer's `public/` folder into `to` (regular files and folders only, nothing outside `to`).
fn unpack(tgz: &Path, to: &Path) -> Result<()> {
    let gz = flate2::read::GzDecoder::new(BufReader::new(std::fs::File::open(tgz)?));
    let mut archive = tar::Archive::new(gz);
    std::fs::create_dir_all(to)?;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let Ok(rel) = path.strip_prefix("public") else { continue };
        if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            continue;
        }
        let dest = to.join(rel);
        match entry.header().entry_type() {
            tar::EntryType::Directory => std::fs::create_dir_all(&dest)?,
            tar::EntryType::Regular => {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::io::copy(&mut entry, &mut std::fs::File::create(&dest)?)?;
            }
            _ => {}
        }
    }
    if !to.join("editor.html").is_file() {
        bail!("bản tải về không có editor.html");
    }
    Ok(())
}

/// What the build needs to run here, done once after unpacking:
/// - x2t (the file converter) is gzip in this image, meant to be sent with `Content-Encoding: gzip`;
///   it is stored as the plain module instead, so the server sends files as they are;
/// - the Vietnamese editor texts lack keys English has, and some of those are read without a
///   fallback (a new slide's "Click to add title" crashes the presentation editor): they get the
///   English text, as the project does for the languages its site offers.
fn prepare(dir: &Path) -> Result<()> {
    let x2t = dir.join("sdkjs/common/wasm/x2t/x2t.wasm.br");
    let bytes = std::fs::read(&x2t).context("thiếu bộ chuyển đổi x2t")?;
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut wasm = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_end(&mut wasm)?;
        std::fs::write(&x2t, wasm)?;
    } else if !bytes.starts_with(b"\0asm") {
        bail!("bộ chuyển đổi x2t không đúng định dạng");
    }
    for app in std::fs::read_dir(dir.join("web-apps/apps"))?.flatten() {
        let locale = app.path().join("main/locale");
        if locale.join("vi.json").is_file() && locale.join("en.json").is_file() {
            fill_locale(&locale.join("en.json"), &locale.join("vi.json"))?;
        }
    }
    Ok(())
}

fn fill_locale(en: &Path, target: &Path) -> Result<()> {
    let en: serde_json::Map<String, Value> = serde_json::from_slice(&std::fs::read(en)?)?;
    let mut t: serde_json::Map<String, Value> = serde_json::from_slice(&std::fs::read(target)?)?;
    let before = t.len();
    for (k, v) in en {
        t.entry(k).or_insert(v);
    }
    if t.len() != before {
        std::fs::write(target, serde_json::to_vec(&t)?)?;
    }
    Ok(())
}

/* ---------------- server ---------------- */

async fn origin() -> Result<String> {
    static SERVER: OnceCell<u16> = OnceCell::const_new();
    let port = SERVER.get_or_try_init(serve).await?;
    Ok(format!("http://127.0.0.1:{port}"))
}

async fn serve() -> Result<u16> {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let port = listener.local_addr()?.port();
    let host = HeaderValue::from_str(&format!("127.0.0.1:{port}"))?;
    let router = Router::new().route(
        "/{*path}",
        get(move |UrlPath(path): UrlPath<String>, headers: HeaderMap| {
            let host = host.clone();
            async move {
                // another name for this address (DNS rebinding) is not this server
                if headers.get(header::HOST) != Some(&host) {
                    return StatusCode::FORBIDDEN.into_response();
                }
                file(&path, &headers).await
            }
        }),
    );
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(port)
}

/// Stands in for the project's service worker, which would copy the editor into the browser's cache
/// and later serve it from there instead of this folder. The editor waits (up to 15 s) for a worker
/// to control the page before it loads, so this one takes control at once and does nothing else.
const SERVICE_WORKER: &str = "self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
";

/// The file a URL path names inside `dir`: `a/` → `a/index.html`, `/editor` → `editor.html`;
/// None for anything outside it.
fn resolve(dir: &Path, url: &str) -> Option<PathBuf> {
    let rel = Path::new(url.trim_start_matches('/'));
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let p = dir.join(rel);
    if p.is_dir() {
        return Some(p.join("index.html")).filter(|p| p.is_file());
    }
    if p.is_file() {
        return Some(p);
    }
    Some(p.with_extension("html")).filter(|p| rel.extension().is_none() && p.is_file())
}

fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

async fn file(url: &str, headers: &HeaderMap) -> Response {
    let common = [(header::CACHE_CONTROL, "no-cache"), (header::CONTENT_SECURITY_POLICY, CSP)];
    if url == "sw.js" {
        return (common, [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], SERVICE_WORKER).into_response();
    }
    let Some(path) = resolve(&site(), url) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let etag = format!("\"{VERSION}-{}-{modified}\"", meta.len());
    if headers.get(header::IF_NONE_MATCH).is_some_and(|v| v.as_bytes() == etag.as_bytes()) {
        return (StatusCode::NOT_MODIFIED, common, [(header::ETAG, etag)]).into_response();
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => (common, [(header::ETAG, etag)], [(header::CONTENT_TYPE, mime(&path))], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vibe-oo-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn unpacks_only_the_site_folder() {
        let d = temp("unpack");
        let tgz = d.join("layer.tgz");
        let mut b = tar::Builder::new(flate2::write::GzEncoder::new(std::fs::File::create(&tgz).unwrap(), flate2::Compression::fast()));
        let mut add = |path: &str, data: &[u8]| {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            b.append_data(&mut h, path, data).unwrap();
        };
        add("public/editor.html", b"<html>");
        add("public/sdkjs/a b.js", b"x");
        add("etc/passwd", b"no");
        b.into_inner().unwrap().finish().unwrap();

        let out = d.join("site");
        unpack(&tgz, &out).unwrap();
        assert_eq!(std::fs::read(out.join("editor.html")).unwrap(), b"<html>");
        assert_eq!(std::fs::read(out.join("sdkjs/a b.js")).unwrap(), b"x");
        assert!(!out.join("etc").exists() && !d.join("etc").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn prepare_unzips_x2t_and_fills_vietnamese() {
        let d = temp("prepare");
        let x2t = d.join("sdkjs/common/wasm/x2t");
        std::fs::create_dir_all(&x2t).unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(b"\0asm\x01\0\0\0rest").unwrap();
        std::fs::write(x2t.join("x2t.wasm.br"), gz.finish().unwrap()).unwrap();
        let loc = d.join("web-apps/apps/presentationeditor/main/locale");
        std::fs::create_dir_all(&loc).unwrap();
        std::fs::write(loc.join("en.json"), r#"{"a":"Title","b":"Body"}"#).unwrap();
        std::fs::write(loc.join("vi.json"), r#"{"a":"Tiêu đề"}"#).unwrap();

        prepare(&d).unwrap();
        assert_eq!(std::fs::read(x2t.join("x2t.wasm.br")).unwrap(), b"\0asm\x01\0\0\0rest");
        let vi: Value = serde_json::from_slice(&std::fs::read(loc.join("vi.json")).unwrap()).unwrap();
        assert_eq!(vi["a"], "Tiêu đề");
        assert_eq!(vi["b"], "Body");
        // a second run leaves the plain module alone
        prepare(&d).unwrap();
        assert_eq!(std::fs::read(x2t.join("x2t.wasm.br")).unwrap(), b"\0asm\x01\0\0\0rest");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn urls_stay_inside_the_site() {
        let d = temp("resolve");
        std::fs::create_dir_all(d.join("help")).unwrap();
        for f in ["editor.html", "help/index.html", "fonts"] {
            std::fs::write(d.join(f), "").unwrap();
        }
        assert_eq!(resolve(&d, "editor.html"), Some(d.join("editor.html")));
        assert_eq!(resolve(&d, "editor"), Some(d.join("editor.html")));
        assert_eq!(resolve(&d, "help/"), Some(d.join("help").join("index.html")));
        assert_eq!(resolve(&d, "fonts"), Some(d.join("fonts")));
        assert_eq!(resolve(&d, "../editor.html"), None);
        assert_eq!(resolve(&d, "C:/Windows/win.ini"), None);
        assert_eq!(resolve(&d, "missing.js"), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
