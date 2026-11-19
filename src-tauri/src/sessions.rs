//! Reads the Claude Code session store (`~/.claude/projects/<encoded-cwd>/<session>.jsonl`),
//! which the Claude desktop app, the CLI and the IDE extensions all share.
//! The JSONL format is internal to Claude Code, so everything here is best-effort:
//! we only pick out cwd, title and timestamps, and skip whatever we don't recognise.

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        LazyLock,
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher, event::ModifyKind};
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::core::{Res, emit, home};

type Obj = Map<String, Value>;

/* ---------------- types (mirror src/shared/types.ts) ---------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    /// folder the session ran in — `claude --resume` must run from here
    pub cwd: String,
    /// repo the session belongs to (worktree sessions roll up to their repo)
    pub project_cwd: String,
    pub created: i64,
    pub updated: i64,
    pub cwd_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub key: String,
    pub cwd: String,
    pub name: String,
    pub updated: i64,
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub used: u64,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTask {
    pub id: String,
    pub command: String,
    pub description: String,
    /// running, completed, failed, killed… (as Claude Code reports it)
    pub status: String,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
    /// the end of its output
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

/* ---------------- commands ---------------- */

#[tauri::command]
pub async fn sessions_list() -> Res<Vec<ProjectGroup>> {
    watch_sessions();
    Ok(tokio::task::spawn_blocking(list_sessions).await?)
}

#[tauri::command]
pub async fn sessions_images(session_id: String) -> Res<Vec<String>> {
    Ok(tokio::task::spawn_blocking(move || session_images(&session_id)).await?)
}

#[tauri::command]
pub async fn sessions_context(session_id: String) -> Res<Option<Context>> {
    Ok(tokio::task::spawn_blocking(move || session_context(&session_id)).await?)
}

#[tauri::command]
pub async fn sessions_tasks(session_id: String) -> Res<Vec<ChatTask>> {
    Ok(tokio::task::spawn_blocking(move || session_tasks(&session_id)).await?)
}

/* ---------------- session list ---------------- */

pub fn projects_dir() -> PathBuf {
    home().join(".claude").join("projects")
}

struct Cached {
    mtime: SystemTime,
    size: u64,
    info: Option<SessionInfo>,
}

static CACHE: LazyLock<Mutex<HashMap<PathBuf, Cached>>> = LazyLock::new(Default::default);

fn ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// `length` bytes from `start` (fewer at the end of the file), decoded lossily like Buffer#toString.
fn read_slice(file: &Path, start: u64, length: u64) -> io::Result<String> {
    let mut f = File::open(file)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(length.min(64 * 1024 * 1024) as usize);
    f.take(length).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn parse_lines(text: &str, drop_first: bool) -> Vec<Obj> {
    text.split('\n')
        .skip(usize::from(drop_first)) // probably cut mid-line
        .filter(|l| l.starts_with('{'))
        .filter_map(|l| serde_json::from_str::<Obj>(l).ok()) // partial lines fail and are skipped
        .collect()
}

fn str_of<'a>(o: &'a Obj, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

fn is_type(o: &Obj, ty: &str) -> bool {
    str_of(o, "type") == Some(ty)
}

/// JS truthiness of an optional JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JS `String(v)`, near enough.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(_) | Value::Number(_) => v.to_string(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `a ?? b ?? ''` over object keys, then `String()`.
fn js_string_coalesce(o: Option<&Obj>, keys: &[&str]) -> String {
    o.and_then(|o| keys.iter().find_map(|k| o.get(*k).filter(|v| !v.is_null())))
        .map(js_string)
        .unwrap_or_default()
}

fn user_text(rec: &Obj) -> Option<String> {
    if !is_type(rec, "user") {
        return None;
    }
    let content = rec.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.as_str(),
        Value::Array(items) => items.iter().find(|c| c.get("type").and_then(Value::as_str) == Some("text"))?.get("text")?.as_str()?,
        _ => return None,
    };
    let text = text.trim();
    // skip injected command / system wrappers
    if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") {
        return None;
    }
    Some(text.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn find_title(recs: &[Obj]) -> Option<String> {
    recs.iter()
        .rev()
        .filter(|r| is_type(r, "custom-title"))
        .find_map(|r| str_of(r, "customTitle").map(str::trim).filter(|t| !t.is_empty()))
        .or_else(|| recs.iter().rev().filter(|r| is_type(r, "summary")).find_map(|r| str_of(r, "summary")))
        .map(str::to_owned)
}

fn read_session(file: &Path, dir_name: &str) -> io::Result<Option<SessionInfo>> {
    let st = fs::metadata(file)?;
    let mtime = st.modified()?;
    let size = st.len();
    if let Some(hit) = CACHE.lock().get(file)
        && hit.mtime == mtime
        && hit.size == size
    {
        return Ok(hit.info.clone());
    }

    const HEAD: u64 = 96 * 1024;
    const TAIL: u64 = 256 * 1024;
    let head = parse_lines(&read_slice(file, 0, HEAD.min(size))?, false);
    let tail = if size > HEAD { parse_lines(&read_slice(file, size.saturating_sub(TAIL), TAIL.min(size))?, true) } else { Vec::new() };

    let mut cwd: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut created: Option<i64> = None;
    for r in &head {
        if cwd.is_none()
            && let Some(c) = str_of(r, "cwd").filter(|c| !c.is_empty())
        {
            cwd = Some(c.to_owned());
        }
        if created.is_none()
            && let Some(ts) = str_of(r, "timestamp")
        {
            created = parse_date(ts).filter(|&t| t != 0);
        }
        if first_prompt.is_none() {
            first_prompt = user_text(r);
        }
        if cwd.is_some() && first_prompt.is_some() && created.is_some() {
            break;
        }
    }

    let head_title = find_title(&head);
    let mut info = None;
    if first_prompt.is_some() || head_title.as_deref().is_some_and(|t| !t.is_empty()) {
        let title = find_title(&tail)
            .or(head_title)
            .or_else(|| first_prompt.as_deref().map(|p| p.chars().take(90).collect()))
            .unwrap_or_default();
        let cwd = cwd.unwrap_or_else(|| decode_dir_name(dir_name));
        info = Some(SessionInfo {
            id: file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            title,
            project_cwd: project_root(&cwd),
            created: created.unwrap_or_else(|| st.created().map(ms).unwrap_or_else(|_| ms(mtime))),
            updated: ms(mtime),
            cwd_exists: Path::new(&cwd).exists(),
            cwd,
        });
    }
    CACHE.lock().insert(file.to_path_buf(), Cached { mtime, size, info: info.clone() });
    Ok(info)
}

/// Lossy fallback when no record carries a cwd: "E--softek-core2" → "E:\softek\core2".
fn decode_dir_name(d: &str) -> String {
    let b = d.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && &b[1..3] == b"--" {
        format!("{}:\\{}", &d[..1], d[3..].replace('-', "\\"))
    } else {
        d.to_owned()
    }
}

/// Worktree sessions belong to the repo they were cut from.
fn project_root(cwd: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(.*?)[\\/]\.claude[\\/]worktrees[\\/]").unwrap());
    RE.captures(cwd).and_then(|c| c.get(1)).map_or_else(|| cwd.to_owned(), |m| m.as_str().to_owned())
}

fn is_sep(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// Path components the way Node's `path` sees them (drive prefix dropped on Windows).
fn path_parts(p: &str) -> Vec<&str> {
    let mut p = p;
    if cfg!(windows) && p.len() >= 2 && p.as_bytes()[1] == b':' && p.as_bytes()[0].is_ascii_alphabetic() {
        p = &p[2..];
    }
    p.split(is_sep).filter(|s| !s.is_empty()).collect()
}

/// `path.basename(p)`
fn basename(p: &str) -> &str {
    path_parts(p).last().copied().unwrap_or("")
}

/// `path.basename(path.dirname(p))`
fn parent_name(p: &str) -> &str {
    let parts = path_parts(p);
    if parts.len() >= 2 { parts[parts.len() - 2] } else { "" }
}

/// `a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })`, approximately:
/// case-insensitive, digit runs compared by value.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                fn take(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
                    let mut s = String::new();
                    while let Some(&c) = it.peek()
                        && c.is_ascii_digit()
                    {
                        s.push(c);
                        it.next();
                    }
                    s
                }
                let (n, m) = (take(&mut x), take(&mut y));
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let o = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(c), Some(d)) => {
                if c != d {
                    return c.cmp(&d);
                }
                x.next();
                y.next();
            }
        }
    }
}

fn list_sessions() -> Vec<ProjectGroup> {
    let root = projects_dir();
    let Ok(rd) = fs::read_dir(&root) else { return Vec::new() };
    let dirs: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();

    let mut jobs: Vec<(PathBuf, String)> = Vec::new();
    for d in dirs {
        let Ok(rd) = fs::read_dir(root.join(&d)) else { continue };
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().ends_with(".jsonl") {
                jobs.push((e.path(), d.clone()));
            }
        }
    }

    // files that are gone drop out of the cache
    {
        let live: HashSet<&PathBuf> = jobs.iter().map(|(p, _)| p).collect();
        CACHE.lock().retain(|p, _| live.contains(p));
    }

    // Unchanged files are a cache hit (one stat); a cold start reads them on a few threads.
    let next = AtomicUsize::new(0);
    let found = Mutex::new(Vec::<SessionInfo>::new());
    let workers = thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8).min(jobs.len().max(1));
    thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| {
                while let Some((file, dir)) = jobs.get(next.fetch_add(1, AtomicOrdering::Relaxed)) {
                    if let Ok(Some(info)) = read_session(file, dir) {
                        found.lock().push(info);
                    }
                }
            });
        }
    });
    let mut all = found.into_inner();
    // newest first, so a group takes its folder spelling from its latest session
    all.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));

    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, ProjectGroup> = HashMap::new();
    for s in all {
        let key = s.project_cwd.to_lowercase().trim_end_matches(['\\', '/']).to_owned();
        let g = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            let name = match basename(&s.project_cwd) {
                "" => s.project_cwd.clone(),
                n => n.to_owned(),
            };
            ProjectGroup { key, cwd: s.project_cwd.clone(), name, updated: 0, sessions: Vec::new() }
        });
        g.updated = g.updated.max(s.updated);
        g.sessions.push(s);
    }
    let mut list: Vec<ProjectGroup> = order.into_iter().filter_map(|k| groups.remove(&k)).collect();
    for g in &mut list {
        g.sessions.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    }

    // Two folders with the same name ("monk" in two places) → add the parent folder to tell them apart.
    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, g) in list.iter().enumerate() {
        by_name.entry(g.name.to_lowercase()).or_default().push(i);
    }
    for same in by_name.values().filter(|v| v.len() >= 2) {
        for &i in same {
            let g = &mut list[i];
            let parent = parent_name(&g.cwd).to_owned();
            if !parent.is_empty() {
                g.name = format!("{} · {parent}", g.name);
            }
        }
    }
    list.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    list
}

/* ---------------- watcher ---------------- */

static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// Whether a change under the store should refresh the list: project folders coming and going,
/// and `.jsonl` files directly inside them (chokidar `depth: 1` with non-jsonl files ignored).
fn relevant(root: &Path, ev: &notify::Event) -> bool {
    if matches!(ev.kind, EventKind::Access(_)) {
        return false;
    }
    let structural = matches!(ev.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)));
    ev.paths.iter().any(|p| {
        let Ok(rel) = p.strip_prefix(root) else { return false };
        if !(1..=2).contains(&rel.components().count()) {
            return false;
        }
        if p.extension().is_some_and(|e| e == "jsonl") {
            return true;
        }
        // folders: only adds / removes, not "something inside changed"
        structural && (p.is_dir() || !p.exists())
    })
}

/// Push a "sessions changed" ping whenever Claude (any client) writes to the store.
fn watch_sessions() {
    let mut slot = WATCHER.lock();
    if slot.is_some() {
        return;
    }
    let root = projects_dir();
    let (tx, rx) = mpsc::channel::<()>();
    let filter_root = root.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res
            && relevant(&filter_root, &ev)
        {
            let _ = tx.send(());
        }
    });
    let Ok(mut watcher) = watcher else { return };
    // the store may not exist yet: leave the slot empty so the next list call tries again
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        return;
    }
    // trailing debounce: one ping 600 ms after the last change
    thread::Builder::new()
        .name("sessions-watch".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                loop {
                    match rx.recv_timeout(Duration::from_millis(600)) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                emit("sessions:changed", [(); 0]);
            }
        })
        .ok();
    *slot = Some(watcher);
}

/* ---------------- one session's file ---------------- */

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn find_session_file(session_id: &str) -> Option<PathBuf> {
    let root = projects_dir();
    let name = format!("{session_id}.jsonl");
    fs::read_dir(&root).ok()?.flatten().map(|e| root.join(e.file_name()).join(&name)).find(|f| f.exists())
}

fn read_session_text(session_id: &str) -> Option<String> {
    if !valid_id(session_id) {
        return None;
    }
    let bytes = fs::read(find_session_file(session_id)?).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/* ---------------- images in a session ---------------- */

const MAX_IMAGES: usize = 40;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

enum Found {
    Data(String),
    Path(String),
}

struct ImageWalk {
    found: Vec<Found>,
    seen: HashSet<String>,
}

impl ImageWalk {
    fn add(&mut self, key: String, item: Found) {
        if self.seen.insert(key) {
            self.found.push(item);
        }
    }

    fn walk(&mut self, blocks: &Value, from_user: bool) {
        static PATH_RE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r#"(?i)[A-Za-z]:[\\/][^"'\n\r<>|*?]+?\.(?:png|jpe?g|gif|webp)(?-u:\b)"#).unwrap());
        let Some(blocks) = blocks.as_array() else { return };
        for b in blocks {
            let Some(b) = b.as_object() else { continue };
            match str_of(b, "type") {
                Some("image") => {
                    let Some(src) = b.get("source").and_then(Value::as_object) else { continue };
                    if str_of(src, "type") == Some("base64")
                        && let Some(data) = str_of(src, "data").filter(|d| !d.is_empty())
                    {
                        let key = format!("{}{}", data.chars().take(200).collect::<String>(), data.len());
                        let mime = str_of(src, "media_type").unwrap_or("image/png");
                        self.add(key, Found::Data(format!("data:{mime};base64,{data}")));
                    }
                }
                Some("tool_result") => {
                    if let Some(c) = b.get("content") {
                        self.walk(c, false);
                    }
                }
                Some("text") if from_user => {
                    if let Some(text) = str_of(b, "text") {
                        for m in PATH_RE.find_iter(text) {
                            self.add(m.as_str().to_lowercase(), Found::Path(m.as_str().to_owned()));
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

/// Every image in a chat, oldest first: pictures pasted into the conversation, screenshots tools
/// returned, and image files named in the user's messages. Returned as data: URLs.
fn session_images(session_id: &str) -> Vec<String> {
    static EXT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(png|jpe?g|gif|webp)").unwrap());
    let Some(text) = read_session_text(session_id) else { return Vec::new() };
    let mut w = ImageWalk { found: Vec::new(), seen: HashSet::new() };
    for line in text.split('\n') {
        if !line.contains("image") && !EXT_RE.is_match(line) {
            continue;
        }
        // partial line while Claude is writing
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        let from_user = row.get("type").and_then(Value::as_str) == Some("user");
        match row.get("message").and_then(|m| m.get("content")) {
            Some(Value::String(s)) => w.walk(&serde_json::json!([{ "type": "text", "text": s }]), from_user),
            Some(c) => w.walk(c, from_user),
            None => {}
        }
    }
    let skip = w.found.len().saturating_sub(MAX_IMAGES);
    let mut out = Vec::new();
    for item in w.found.into_iter().skip(skip) {
        match item {
            Found::Data(d) => out.push(d),
            Found::Path(p) => {
                let Some(mime) = p.rsplit('.').next().and_then(image_mime) else { continue };
                // the file may be gone (e.g. temp paste cleaned up)
                let Ok(st) = fs::metadata(&p) else { continue };
                if !st.is_file() || st.len() > MAX_FILE_BYTES {
                    continue;
                }
                if let Ok(bytes) = fs::read(&p) {
                    out.push(format!("data:{mime};base64,{}", B64.encode(bytes)));
                }
            }
        }
    }
    out
}

/* ---------------- context window ---------------- */

/// How full a chat's context window is: the token count of the last main-thread API call
/// (input + cache read + cache write + output), from the tail of the session file.
fn session_context(session_id: &str) -> Option<Context> {
    if !valid_id(session_id) {
        return None;
    }
    let file = find_session_file(session_id)?;
    let size = fs::metadata(&file).ok()?.len();
    // widen the window until a usage line turns up (big tool results can push it far back)
    for span in [256 * 1024, 4 * 1024 * 1024, size] {
        let start = size.saturating_sub(span);
        let rows = parse_lines(&read_slice(&file, start, size - start).ok()?, start > 0);
        for r in rows.iter().rev() {
            if !is_type(r, "assistant") || truthy(r.get("isSidechain")) || truthy(r.get("isApiErrorMessage")) {
                continue;
            }
            let Some(msg) = r.get("message").and_then(Value::as_object) else { continue };
            let model = str_of(msg, "model");
            if model == Some("<synthetic>") {
                continue;
            }
            let Some(u) = msg.get("usage").and_then(Value::as_object) else { continue };
            let n = |k: &str| u.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            let used = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
            if used > 0.0 {
                return Some(Context { used: used as u64, model: model.unwrap_or_default().to_owned() });
            }
        }
        if start == 0 {
            break;
        }
    }
    None
}

/* ---------------- background tasks ---------------- */

/// Background tasks Claude started in a chat (Bash/PowerShell with run_in_background), with their
/// status from the task notifications and the last part of their output file.
fn session_tasks(session_id: &str) -> Vec<ChatTask> {
    static OUTPUT_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"Output is being written to: ([^\n\r\u{2028}\u{2029}]+?\.output)").unwrap());
    static NOTE_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)<task-id>([^<]+)</task-id>.*?<status>([^<]+)</status>").unwrap());
    static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").unwrap());

    let Some(text) = read_session_text(session_id) else { return Vec::new() };
    struct Call {
        command: String,
        description: String,
    }
    let mut calls: HashMap<String, Call> = HashMap::new();
    // insertion-ordered map: a re-set task keeps its first position, like a JS Map
    let mut tasks: Vec<ChatTask> = Vec::new();
    let mut task_index: HashMap<String, usize> = HashMap::new();
    let mut ended: HashMap<String, (String, i64)> = HashMap::new();

    for line in text.split('\n') {
        if !line.contains("run_in_background") && !line.contains("backgroundTaskId") && !line.contains("<task-notification>") {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Obj>(line) else { continue };
        let at = match row.get("timestamp") {
            None | Some(Value::Null) => None,
            Some(v) => parse_date(&js_string(v)),
        }
        .unwrap_or(0);
        let content = row.get("message").and_then(|m| m.get("content")).and_then(Value::as_array);

        if is_type(&row, "assistant")
            && let Some(content) = content
        {
            for b in content {
                let Some(b) = b.as_object() else { continue };
                let input = b.get("input").and_then(Value::as_object);
                if is_type(b, "tool_use")
                    && let Some(id) = str_of(b, "id").filter(|id| !id.is_empty())
                    && truthy(input.and_then(|i| i.get("run_in_background")))
                {
                    calls.insert(
                        id.to_owned(),
                        Call {
                            command: js_string_coalesce(input, &["command", "prompt"]),
                            description: js_string_coalesce(input, &["description"]),
                        },
                    );
                }
            }
        }

        let task_id = row.get("toolUseResult").and_then(|r| r.get("backgroundTaskId")).and_then(Value::as_str).filter(|s| !s.is_empty());
        if let Some(task_id) = task_id
            && let Some(content) = content
        {
            let r = content.iter().filter_map(Value::as_object).find(|b| is_type(b, "tool_result"));
            let msg = match r.and_then(|r| r.get("content")) {
                Some(Value::String(s)) => s.clone(),
                Some(v) if !v.is_null() => v.to_string(),
                _ => "\"\"".to_owned(),
            };
            let call = calls.get(r.and_then(|r| str_of(r, "tool_use_id")).unwrap_or(""));
            let task = ChatTask {
                id: task_id.to_owned(),
                command: call.map(|c| c.command.clone()).unwrap_or_default(),
                description: call.map(|c| c.description.clone()).unwrap_or_default(),
                status: "running".into(),
                started_at: at,
                ended_at: None,
                output_file: OUTPUT_RE.captures(&msg).map(|c| c[1].to_owned()),
                output: None,
            };
            match task_index.get(task_id) {
                Some(&i) => tasks[i] = task,
                None => {
                    task_index.insert(task_id.to_owned(), tasks.len());
                    tasks.push(task);
                }
            }
        }

        // the notification shows up several times (queued, delivered): the first one is when it ended
        let note = str_of(&row, "content").unwrap_or(line);
        for c in NOTE_RE.captures_iter(note) {
            ended.entry(c[1].to_owned()).or_insert_with(|| (c[2].to_owned(), at));
        }
    }

    tasks.reverse();
    for t in &mut tasks {
        if let Some((status, at)) = ended.get(&t.id) {
            t.status = status.clone();
            t.ended_at = Some(*at);
        }
        let Some(out_file) = &t.output_file else { continue };
        // the output file may have been cleaned up
        if let Ok(st) = fs::metadata(out_file)
            && let Ok(tail) = read_slice(Path::new(out_file), st.len().saturating_sub(6000), 6000)
        {
            t.output = Some(ANSI_RE.replace_all(&tail, "").into_owned());
        }
    }
    tasks
}

/* ---------------- dates ---------------- */

/// `Date.parse` for the ISO 8601 timestamps Claude Code writes ("2025-01-02T03:04:05.678Z").
/// Times without an offset are read as UTC. `None` where JS would give NaN.
fn parse_date(s: &str) -> Option<i64> {
    let b = s.trim().as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    if b.len() == 10 {
        return Some(days * 86_400_000);
    }
    if !matches!(b.get(10), Some(b'T' | b't' | b' ')) || b.get(13) != Some(&b':') {
        return None;
    }
    let (h, mi) = (num(11, 2)?, num(14, 2)?);
    let mut i = 16;
    let mut sec = 0;
    let mut millis = 0;
    if b.get(i) == Some(&b':') {
        sec = num(i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return None;
            }
            let frac = &b[start..i.min(start + 3)];
            millis = frac.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')) * 10i64.pow(3 - frac.len() as u32);
        }
    }
    if h > 24 || mi > 59 || sec > 59 {
        return None;
    }
    let offset_min = match b.get(i) {
        None => 0,
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let oh = num(i + 1, 2)?;
            let om = match b.get(i + 3) {
                Some(b':') => num(i + 4, 2).filter(|_| i + 6 == b.len())?,
                Some(_) => num(i + 3, 2).filter(|_| i + 5 == b.len())?,
                None => 0,
            };
            let off = oh * 60 + om;
            if sign == b'+' { off } else { -off }
        }
        _ => return None,
    };
    Some((days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60) * 1000 + millis)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(parse_date("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_date("2025-01-02T03:04:05.678Z"), Some(1_735_787_045_678));
        assert_eq!(parse_date("2025-01-02T05:04:05.678+02:00"), Some(1_735_787_045_678));
        assert_eq!(parse_date("nope"), None);
    }

    #[test]
    fn paths() {
        assert_eq!(decode_dir_name("E--softek-core2"), "E:\\softek\\core2");
        assert_eq!(project_root("E:\\x\\repo\\.claude\\worktrees\\a"), "E:\\x\\repo");
        assert_eq!(natural_cmp("a10", "A9"), Ordering::Greater);
    }
}
