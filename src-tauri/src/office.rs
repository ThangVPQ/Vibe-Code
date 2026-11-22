//! Office tab: Docs (.docx), Sheets (.xlsx / .csv) and PDF. The page holds the open files (FortuneSheet
//! for sheets, a rich-text editor for docs, pdf.js for PDFs) and turns them into file bytes and back.
//! This side only:
//!   - reads and writes the files, with the file dialog, and keeps the "recent files" list;
//!   - relays Claude's vibe-office tool calls to the page, which runs them on what the user sees:
//!     `office:request` goes out (also kept in a queue until the tab is mounted and picks it up),
//!     `office_reply` brings the answer back.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::core::{Res, app, emit, user_data};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/* ---------------- files ---------------- */

fn read_csv(path: &str) -> Result<Vec<Vec<String>>> {
    let bytes = std::fs::read(path).with_context(|| format!("không đọc được {path}"))?;
    let text = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).into_owned();
    let mut rdr = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(text.as_bytes());
    Ok(rdr.records().map(|r| r.map(|r| r.iter().map(str::to_owned).collect())).collect::<Result<_, _>>()?)
}

/// UTF-8 with a BOM, so Excel shows Vietnamese right.
fn write_csv(path: &str, rows: &[Vec<String>]) -> Result<()> {
    let mut w = csv::WriterBuilder::new().flexible(true).from_writer(b"\xEF\xBB\xBF".to_vec());
    for row in rows {
        w.write_record(row)?;
    }
    let bytes = w.into_inner().map_err(|e| anyhow!("{e}"))?;
    std::fs::write(path, bytes).with_context(|| format!("không lưu được {path} (file đang mở trong Excel?)"))
}

/// What the ONLYOFFICE editor opens (onlyoffice.rs).
const OO_EXTS: [&str; 11] = ["docx", "xlsx", "pptx", "csv", "doc", "xls", "ppt", "odt", "ods", "odp", "rtf"];

/// File dialog: pick a file to open, or (`save`) name a new one. `kind` narrows the file types:
/// "doc", "sheet", "pdf" or "oo" (ONLYOFFICE; anything else: every kind the Office tab opens).
#[tauri::command]
pub async fn office_pick(save: bool, kind: Option<String>) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let mut d = app().dialog().file();
    d = match kind.as_deref() {
        Some("doc") => d.add_filter("Tài liệu Word", &["docx"]),
        Some("sheet") => d.add_filter("Bảng tính", &["xlsx", "csv"]),
        Some("pdf") => d.add_filter("PDF", &["pdf"]),
        Some("oo") => d.add_filter("Word, Excel, PowerPoint", &OO_EXTS),
        _ => d.add_filter("Tài liệu, bảng tính, trình chiếu, PDF", &[&OO_EXTS[..], &["pdf"]].concat()),
    };
    if let Some(w) = crate::core::main_window() {
        d = d.set_parent(&w);
    }
    let name = if kind.as_deref() == Some("doc") { "Tai lieu.docx" } else { "Bang tinh.xlsx" };
    let picked = tokio::task::spawn_blocking(move || if save { d.set_file_name(name).blocking_save_file() } else { d.blocking_pick_file() }).await?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

/// A file's bytes (an ArrayBuffer on the page): .xlsx, .docx, .pdf.
#[tauri::command]
pub async fn office_read_file(path: String) -> Res<tauri::ipc::Response> {
    let bytes = tokio::fs::read(&path).await.with_context(|| format!("không đọc được {path}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Writes a file the page built (base64).
#[tauri::command]
pub async fn office_write_file(path: String, data: String) -> Res<()> {
    let bytes = B64.decode(data)?;
    tokio::fs::write(&path, bytes).await.with_context(|| format!("không lưu được {path} (file đang mở ở chương trình khác?)"))?;
    Ok(())
}

/// Copies a file into `<userData>/office-backups` before the Office tab first overwrites it (the
/// editors don't keep everything a .docx/.xlsx can hold); returns the copy's path. Keeps the newest 200.
#[tauri::command]
pub async fn office_backup(path: String) -> Res<String> {
    Ok(tokio::task::spawn_blocking(move || backup(&path, &user_data().join("office-backups"))).await??)
}

fn backup(path: &str, dir: &Path) -> Result<String> {
    std::fs::create_dir_all(dir)?;
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let to = dir.join(format!("{stamp} {name}"));
    std::fs::copy(path, &to).with_context(|| format!("không sao lưu được {path}"))?;
    let mut old: Vec<_> = std::fs::read_dir(dir)?.flatten().map(|e| e.path()).collect();
    if old.len() > 200 {
        old.sort();
        for p in &old[..old.len() - 200] {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(to.to_string_lossy().into_owned())
}

/* ---------------- recent files ---------------- */

const RECENT_MAX: usize = 50;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    path: String,
    /// bytes; 0 when the file is gone
    size: u64,
    /// ms since epoch, 0 when unknown
    modified: u64,
    exists: bool,
}

fn recent_file() -> std::path::PathBuf {
    user_data().join("office-recent.json")
}

fn recent_paths() -> Vec<String> {
    std::fs::read_to_string(recent_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn same_path(a: &str, b: &str) -> bool {
    a.replace('/', "\\").eq_ignore_ascii_case(&b.replace('/', "\\"))
}

/// Moves `path` to the top of `list` (adding it), keeping at most RECENT_MAX.
fn bump(mut list: Vec<String>, path: &str) -> Vec<String> {
    list.retain(|p| !same_path(p, path));
    list.insert(0, path.to_owned());
    list.truncate(RECENT_MAX);
    list
}

fn info(path: String) -> RecentFile {
    match std::fs::metadata(&path) {
        Ok(m) => RecentFile {
            size: m.len(),
            modified: m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64),
            exists: true,
            path,
        },
        Err(_) => RecentFile { path, size: 0, modified: 0, exists: false },
    }
}

/// Files opened in the Office tab, most recent first, with their size and last change on disk.
#[tauri::command]
pub async fn office_recent() -> Res<Vec<RecentFile>> {
    Ok(tokio::task::spawn_blocking(|| recent_paths().into_iter().map(info).collect()).await?)
}

/// `remove`: take it off the list; otherwise put it on top.
#[tauri::command]
pub async fn office_recent_add(path: String, remove: Option<bool>) -> Res<()> {
    let list = if remove == Some(true) {
        let mut l = recent_paths();
        l.retain(|p| !same_path(p, &path));
        l
    } else {
        bump(recent_paths(), &path)
    };
    std::fs::write(recent_file(), serde_json::to_vec(&list)?)?;
    Ok(())
}

#[tauri::command]
pub async fn office_read_csv(path: String) -> Res<Vec<Vec<String>>> {
    Ok(tokio::task::spawn_blocking(move || read_csv(&path)).await??)
}

#[tauri::command]
pub async fn office_write_csv(path: String, rows: Vec<Vec<String>>) -> Res<()> {
    Ok(tokio::task::spawn_blocking(move || write_csv(&path, &rows)).await??)
}

/* ---------------- Claude's tools, run by the page ---------------- */

#[derive(Serialize, Clone)]
pub struct Request {
    id: u64,
    tool: String,
    args: Value,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// calls the page has not picked up yet (the Office tab mounts on first use)
static PENDING: LazyLock<Mutex<Vec<Request>>> = LazyLock::new(Default::default);
static WAITING: LazyLock<Mutex<HashMap<u64, oneshot::Sender<Result<String, String>>>>> = LazyLock::new(Default::default);

/// The calls waiting for the page; it runs each once and answers with `office_reply`.
#[tauri::command]
pub async fn office_pending() -> Res<Vec<Request>> {
    Ok(std::mem::take(&mut *lock(&PENDING)))
}

#[tauri::command]
pub async fn office_reply(id: u64, ok: bool, text: String) -> Res<()> {
    lock(&PENDING).retain(|r| r.id != id);
    if let Some(tx) = lock(&WAITING).remove(&id) {
        let _ = tx.send(if ok { Ok(text) } else { Err(text) });
    }
    Ok(())
}

pub const INSTRUCTIONS: &str = "Work with the files open in VIBE CODE's Office tab — the user sees them there: Docs (.docx, a Word-like editor), Sheets (.xlsx/.csv, an Excel-like grid) and PDF (a viewer). \
Several files can be open, one tab each; tools act on the one on screen of their kind unless `file` names another (its path or file name). \
Use these tools when the user mentions 'tab Office', 'the document/sheet/PDF', 'tài liệu', 'bảng tính', 'file Word/Excel/PDF', or what is in them. Start with office_status. \
Edits show up live and the tab saves the file by itself about a second later. \
Sheets: a value starting with '=' is an Excel formula; the grid calculates it, and formatting in the file is kept on save. \
Docs: content is HTML (headings, paragraphs, bold/italic/underline, colors, lists, tables, images); saving to .docx keeps that, but not page headers/footers, sections or text boxes. \
PDFs are read-only.";

pub fn tools() -> Value {
    let file = json!({ "type": "string", "description": "path or file name of an open file (default: the one on screen)" });
    json!([
        {
            "name": "office_status",
            "description": "The files open in the Office tab (docs, sheets, PDFs; the one on screen is marked): path, unsaved changes, and per kind sheets with their used size, PDF page count.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "office_open",
            "description": "Open a .docx, .xlsx, .csv or .pdf file in its own tab of the Office tab and show it (or just show it when it is open already). `create: true` makes a new empty .docx/.xlsx/.csv at `path`.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "absolute path" }, "create": { "type": "boolean" } },
                "required": ["path"]
            }
        },
        {
            "name": "sheet_read",
            "description": "Cells of one sheet as tab-separated rows, each starting with its row number; the first line names the columns. Cells show their displayed value; formula cells add ` [=FORMULA]`. Default: the first 200 rows of the sheet on screen. At most 1000 rows per call.",
            "inputSchema": {
                "type": "object",
                "properties": { "file": file, "sheet": { "type": "string", "description": "sheet name (default: the one on screen)" }, "range": { "type": "string", "description": "e.g. \"A1:F100\" or \"A200:Z400\"" } }
            }
        },
        {
            "name": "sheet_write",
            "description": "Write a block of cells starting at `cell` (top-left), row by row. Strings starting with '=' are formulas, \"\" clears a cell, null leaves it as it is. A sheet name that does not exist yet is added (xlsx only). The file is saved automatically about a second later.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file": file,
                    "sheet": { "type": "string", "description": "sheet name (default: the one on screen)" },
                    "cell": { "type": "string", "description": "top-left cell, e.g. \"A1\"" },
                    "values": { "type": "array", "items": { "type": "array", "items": { "type": ["string", "number", "boolean", "null"] } } }
                },
                "required": ["cell", "values"]
            }
        },
        {
            "name": "sheet_save",
            "description": "Save a spreadsheet to its file now (edits are also saved automatically a second after they stop).",
            "inputSchema": { "type": "object", "properties": { "file": file } }
        },
        {
            "name": "doc_read",
            "description": "The content of an open document as HTML (p, h1-h3, strong/em/u/s, span style color/font-size, mark, ul/ol/li, table, img, text-align).",
            "inputSchema": { "type": "object", "properties": { "file": file } }
        },
        {
            "name": "doc_write",
            "description": "Change an open document: `mode` \"replace\" puts `html` in place of the whole content, \"append\" adds it at the end (default). Use the same HTML as doc_read returns. Saved automatically about a second later.",
            "inputSchema": {
                "type": "object",
                "properties": { "file": file, "html": { "type": "string" }, "mode": { "type": "string", "enum": ["append", "replace"] } },
                "required": ["html"]
            }
        },
        {
            "name": "pdf_read",
            "description": "Text of an open PDF, page by page. `pages`: e.g. \"1-5\" or \"3\" (default: the first 20 pages). Scanned PDFs (images only) have no text.",
            "inputSchema": { "type": "object", "properties": { "file": file, "pages": { "type": "string" } } }
        }
    ])
}

const TOOLS: [&str; 8] = ["office_status", "office_open", "sheet_read", "sheet_write", "sheet_save", "doc_read", "doc_write", "pdf_read"];

/// Hands one call to the page (opening the Office tab if needed) and waits for its answer.
pub async fn call_tool(name: &str, args: Value) -> Result<String> {
    let (req, rx) = enqueue(name, args)?;
    emit("office:request", (req.clone(),));
    wait(req, rx).await
}

type Answer = oneshot::Receiver<Result<String, String>>;

fn enqueue(name: &str, args: Value) -> Result<(Request, Answer)> {
    if !TOOLS.contains(&name) {
        bail!("unknown tool {name}");
    }
    let req = Request { id: NEXT_ID.fetch_add(1, Ordering::Relaxed), tool: name.to_owned(), args };
    let (tx, rx) = oneshot::channel();
    lock(&WAITING).insert(req.id, tx);
    lock(&PENDING).push(req.clone());
    Ok((req, rx))
}

async fn wait(req: Request, rx: Answer) -> Result<String> {
    let answer = tokio::time::timeout(Duration::from_secs(120), rx).await;
    lock(&WAITING).remove(&req.id);
    lock(&PENDING).retain(|r| r.id != req.id);
    match answer {
        Ok(Ok(Ok(text))) => Ok(text),
        Ok(Ok(Err(e))) => Err(anyhow!(e)),
        _ => bail!("The Office tab did not answer (is VIBE CODE's window open?)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_round_trip() {
        let path = std::env::temp_dir().join(format!("vibe-office-test-{}.csv", std::process::id())).to_string_lossy().into_owned();
        let rows = vec![vec!["a,b".to_owned(), "Việt".to_owned()], vec!["x\"y".to_owned(), String::new()]];
        write_csv(&path, &rows).unwrap();
        let back = read_csv(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(back, rows);
    }

    #[test]
    fn recent_list_moves_a_file_to_the_top_once() {
        let l = bump(vec![r"C:\a.xlsx".into(), r"C:\b.docx".into()], "c:/B.docx");
        assert_eq!(l, ["c:/B.docx", r"C:\a.xlsx"]);
        let many = (0..60).fold(Vec::new(), |l, i| bump(l, &format!(r"C:\f{i}.pdf")));
        assert_eq!(many.len(), RECENT_MAX);
        assert_eq!(many[0], r"C:\f59.pdf");
    }

    #[test]
    fn backup_copies_the_file_aside() {
        let dir = std::env::temp_dir().join(format!("vibe-office-bk-{}", std::process::id()));
        let src = dir.join("Báo cáo.docx");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&src, b"original").unwrap();
        let to = backup(&src.to_string_lossy(), &dir.join("bk")).unwrap();
        assert!(to.ends_with(" Báo cáo.docx"));
        assert_eq!(std::fs::read(&to).unwrap(), b"original");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_listed_tool_is_accepted() {
        let listed: Vec<String> = tools().as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(listed, TOOLS);
    }

    #[tokio::test]
    async fn tool_calls_wait_for_the_page() {
        let (req, rx) = enqueue("sheet_write", json!({ "cell": "A1" })).unwrap();
        let id = req.id;
        let call = tokio::spawn(wait(req, rx));
        // the page (mounted late) picks it up from the queue, then answers
        let picked = office_pending().await.unwrap();
        assert!(picked.iter().any(|r| r.id == id && r.tool == "sheet_write" && r.args["cell"] == "A1"));
        office_reply(id, true, "ok from page".into()).await.unwrap();
        assert_eq!(call.await.unwrap().unwrap(), "ok from page");

        let (req, rx) = enqueue("sheet_save", json!({})).unwrap();
        office_reply(req.id, false, "locked by Excel".into()).await.unwrap();
        assert_eq!(wait(req, rx).await.unwrap_err().to_string(), "locked by Excel");
        assert!(enqueue("rm_rf", json!({})).is_err());
    }
}
