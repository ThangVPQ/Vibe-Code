//! Personal Zalo account (port of src/main/zalo.ts; the protocol is a Rust port of zca-js).
//!
//! Login is a QR scan; the session (imei + cookies + user agent) is kept encrypted so the next
//! launch logs in by itself. Zalo has no "list my conversations with history" call for 1-to-1
//! chats, so we keep our own cache: everything the listener receives (live messages and the recent
//! history Zalo replays on connect) lands in userData/zalo/cache.json.

mod api;
mod cookies;
mod listen;
mod proto;
mod tools;
mod types;

use std::{
    cmp::Ordering as CmpOrdering,
    path::PathBuf,
    sync::{
        Arc, LazyLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use indexmap::{IndexMap, IndexSet};
use parking_lot::{Mutex, MutexGuard};
use serde::Serialize;
use serde_json::Value;
use tokio::{sync::mpsc, task::AbortHandle};

pub use tools::{INSTRUCTIONS, call_tool, tools};
pub use types::*;

use crate::core::{self, Res, emit};
use api::{Api, Credentials, Outgoing, QrEvent, Quote, SeenMsg, ThreadType};
use listen::{Action, Event, Listener, Msg};
use proto::{jnum, jstr, now_ms, truthy};

const MAX_PER_THREAD: usize = 3000;
const OLD_PAGES: u32 = 15;

fn dir() -> PathBuf {
    core::user_data().join("zalo")
}
fn cred_file() -> PathBuf {
    dir().join("session.bin")
}
fn cache_file() -> PathBuf {
    dir().join("cache.json")
}

/* ---------------- state ---------------- */

#[derive(Default)]
struct Store {
    loaded: bool,
    threads: IndexMap<String, ZaloThread>,
    messages: IndexMap<String, Vec<ZaloMessage>>,
    /// userId / groupId → display name (friends, groups, senders seen)
    names: IndexMap<String, String>,
    /// userId / groupId → avatar url
    avatars: IndexMap<String, String>,
    /// ids of my friends (for the contact list)
    friends: IndexSet<String>,
    /// stickerId → image url
    stickers: IndexMap<i64, String>,
    /// when this app was last online with Zalo: replayed messages newer than that arrived while away
    synced_at: i64,
    away_from: i64,
    /// the conversation open in the Zalo tab (its messages count as read)
    active: Option<String>,
    state: ZaloState,
    retries: u32,
    replay_pages: [u32; 2],
    /// profiles asked for (never asked twice)
    profile_queue: IndexSet<String>,
    profile_timer: bool,
    last_typing: i64,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(Default::default);

/// The store, with the cache loaded on first use.
fn store() -> MutexGuard<'static, Store> {
    let mut s = STORE.lock();
    if !s.loaded {
        s.loaded = true;
        load_cache(&mut s);
    }
    s
}

struct Session {
    id: u64,
    api: Arc<Api>,
    listener: Arc<Listener>,
}

static SESSION: Mutex<Option<Arc<Session>>> = Mutex::new(None);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
/// bumped by every login attempt / logout: a login that finishes after a newer one started is dropped
static GEN: AtomicU64 = AtomicU64::new(0);
static RETRY: Mutex<Option<AbortHandle>> = Mutex::new(None);
static QR_ABORT: Mutex<Option<AbortHandle>> = Mutex::new(None);

fn session() -> Option<Arc<Session>> {
    SESSION.lock().clone()
}

/// The logged-in API, online or not (zalo.ts' `api`).
fn api_any() -> Option<Arc<Api>> {
    session().map(|s| s.api.clone())
}

fn need() -> anyhow::Result<Arc<Api>> {
    let a = api_any();
    match a {
        Some(a) if store().state.status == "online" => Ok(a),
        _ => anyhow::bail!("Zalo chưa đăng nhập. Mở tab Zalo trong VIBE CODE và quét QR (hoặc bấm Kết nối lại)."),
    }
}

pub fn state() -> ZaloState {
    store().state.clone()
}

fn set_state(f: impl FnOnce(&mut ZaloState)) {
    let st = {
        let mut s = store();
        f(&mut s.state);
        s.state.clone()
    };
    emit("zalo:state", (st,));
}

fn spawn<F: Future<Output = ()> + Send + 'static>(f: F) {
    tauri::async_runtime::spawn(f);
}

fn window_focused() -> bool {
    core::main_window().and_then(|w| w.is_focused().ok()).unwrap_or(false)
}

/* ---------------- cache ---------------- */

fn load_cache(s: &mut Store) {
    let Ok(text) = std::fs::read_to_string(cache_file()) else { return };
    let Ok(c) = serde_json::from_str::<Value>(&text) else { return };
    for t in c["threads"].as_array().into_iter().flatten() {
        if let Ok(t) = serde_json::from_value::<ZaloThread>(t.clone()) {
            s.threads.insert(t.id.clone(), t);
        }
    }
    for (k, v) in c["messages"].as_object().into_iter().flatten() {
        let list: Vec<ZaloMessage> = v.as_array().into_iter().flatten().filter_map(|m| serde_json::from_value(m.clone()).ok()).collect();
        s.messages.insert(k.clone(), list);
    }
    for (k, v) in c["names"].as_object().into_iter().flatten() {
        if let Some(v) = v.as_str() {
            s.names.insert(k.clone(), v.to_owned());
        }
    }
    for (k, v) in c["avatars"].as_object().into_iter().flatten() {
        if let Some(v) = v.as_str() {
            s.avatars.insert(k.clone(), v.to_owned());
        }
    }
    for id in c["friends"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        s.friends.insert(id.to_owned());
    }
    for (k, v) in c["stickers"].as_object().into_iter().flatten() {
        if let (Ok(id), Some(v)) = (k.parse::<i64>(), v.as_str()) {
            s.stickers.insert(id, v.to_owned());
        }
    }
    s.synced_at = c["syncedAt"].as_i64().unwrap_or(0);
    s.away_from = s.synced_at;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheOut<'a> {
    threads: Vec<&'a ZaloThread>,
    messages: &'a IndexMap<String, Vec<ZaloMessage>>,
    names: &'a IndexMap<String, String>,
    avatars: &'a IndexMap<String, String>,
    friends: &'a IndexSet<String>,
    stickers: &'a IndexMap<i64, String>,
    synced_at: i64,
}

async fn write_cache() {
    let data = {
        let mut s = store();
        if s.state.status == "online" {
            s.synced_at = now_ms();
        }
        serde_json::to_vec(&CacheOut {
            threads: s.threads.values().filter(|t| t.contact != Some(true)).collect(),
            messages: &s.messages,
            names: &s.names,
            avatars: &s.avatars,
            friends: &s.friends,
            stickers: &s.stickers,
            synced_at: s.synced_at,
        })
    };
    if let Ok(data) = data {
        let _ = core::write_atomic(cache_file(), data).await;
    }
}

#[derive(Default)]
struct Timers {
    ids: IndexSet<String>,
    changed_pending: bool,
    save_pending: bool,
}
static TIMERS: LazyLock<Mutex<Timers>> = LazyLock::new(Default::default);

/// Something changed in these conversations: tell the window soon, write the disk a little later.
fn changed(ids: impl IntoIterator<Item = String>) {
    let mut t = TIMERS.lock();
    t.ids.extend(ids);
    if !t.changed_pending {
        t.changed_pending = true;
        spawn(async {
            tokio::time::sleep(Duration::from_millis(120)).await;
            let list: Vec<String> = {
                let mut t = TIMERS.lock();
                t.changed_pending = false;
                t.ids.drain(..).collect()
            };
            emit("zalo:changed", (list,));
        });
    }
    if !t.save_pending {
        t.save_pending = true;
        spawn(async {
            tokio::time::sleep(Duration::from_secs(3)).await;
            TIMERS.lock().save_pending = false;
            write_cache().await;
        });
    }
}

fn all_thread_ids() -> Vec<String> {
    store().threads.keys().cloned().collect()
}

/* ---------------- parsing Zalo messages ---------------- */

pub fn attach_label(kind: &str) -> &'static str {
    match kind {
        "photo" => "Ảnh",
        "video" => "Video",
        "voice" => "Tin nhắn thoại",
        "sticker" => "Sticker",
        "gif" => "GIF",
        "file" => "File",
        "link" => "Link",
        "location" => "Vị trí",
        "card" => "Danh thiếp",
        _ => "Tin nhắn",
    }
}

fn parse_json_obj(v: Option<&Value>) -> Value {
    match v {
        Some(o @ Value::Object(_)) => o.clone(),
        Some(Value::String(s)) if s.trim().starts_with('{') => serde_json::from_str::<Value>(s).ok().filter(Value::is_object).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn vstr(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn vnum(v: Option<&Value>) -> Option<f64> {
    let n = jnum(v);
    (n.is_finite() && n > 0.0).then_some(n)
}

/// What an attachment message carries, in one shape for the UI.
fn parse_attachment(msg_type: &str, content: &Value, stickers: &IndexMap<i64, String>) -> Option<ZaloAttachment> {
    if !content.is_object() {
        return None;
    }
    let c = content;
    let p = parse_json_obj(c.get("params"));
    let base = ZaloAttachment { url: vstr(c.get("href")), thumb: vstr(c.get("thumb")), title: vstr(c.get("title")), desc: vstr(c.get("description")), ..Default::default() };
    let t = msg_type.strip_prefix("chat.").or_else(|| msg_type.strip_prefix("share.")).unwrap_or(msg_type);
    let k = |kind: &str, a: ZaloAttachment| Some(ZaloAttachment { kind: kind.into(), ..a });
    let dur = || vnum(p.get("duration")).map(|d| d / 1000.0);
    if t == "photo" || t == "doodle" {
        let url = vstr(p.get("hd")).or_else(|| vstr(p.get("rawUrl"))).or(base.url.clone());
        return k("photo", ZaloAttachment { url, width: vnum(p.get("width")), height: vnum(p.get("height")), ..base });
    }
    if t.starts_with("video") {
        return k("video", ZaloAttachment { width: vnum(p.get("video_width")), height: vnum(p.get("video_height")), duration: dur(), ..base });
    }
    if t == "voice" {
        return k("voice", ZaloAttachment { duration: dur(), ..base });
    }
    if t == "gif" {
        return k("gif", ZaloAttachment { width: vnum(p.get("width")), height: vnum(p.get("height")), ..base });
    }
    if t == "sticker" {
        let id = vnum(c.get("id"))? as i64;
        let cat = c.get("catId").filter(|v| !v.is_null()).or_else(|| c.get("cateId"));
        let num0 = |v: Option<&Value>| {
            let n = jnum(v);
            if n.is_finite() { n as i64 } else { 0 }
        };
        return Some(ZaloAttachment {
            kind: "sticker".into(),
            sticker: Some(StickerRef { id, cate_id: num0(cat), kind: num0(c.get("type")) }),
            url: stickers.get(&id).cloned(),
            ..Default::default()
        });
    }
    if t == "file" {
        return k("file", ZaloAttachment { size: vnum(p.get("fileSize")), ext: vstr(p.get("fileExt")).map(|e| e.to_lowercase()), ..base });
    }
    if t.starts_with("location") {
        return k("location", base);
    }
    if t == "recommended" || t == "link" {
        let action = vstr(c.get("action")).unwrap_or_default();
        if action.contains("user") {
            let desc = vstr(p.get("phone")).or(base.desc.clone());
            return k("card", ZaloAttachment { desc, ..base });
        }
        return k("link", base);
    }
    k("other", base)
}

/// Readable text for any Zalo message: plain text as is, attachments as "[kind] title url".
fn content_text(att: Option<&ZaloAttachment>, content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_owned();
    }
    let Some(a) = att else { return "[tin nhắn]".into() };
    let mut parts = vec![format!("[{}]", attach_label(&a.kind).to_lowercase())];
    for v in [&a.title, &a.desc, &a.url].into_iter().flatten() {
        if !parts.contains(v) {
            parts.push(v.clone());
        }
    }
    parts.join(" ")
}

/// One line for the conversation list.
pub fn preview_of(m: &ZaloMessage) -> String {
    if m.recalled == Some(true) {
        return "Tin nhắn đã thu hồi".into();
    }
    let Some(a) = &m.att else { return m.text.clone() };
    let title = |d: &str| a.title.clone().unwrap_or_else(|| d.into());
    match a.kind.as_str() {
        "file" => format!("📎 {}", title("File")),
        "photo" => format!("🖼 {}", title("Ảnh")),
        "video" => format!("🎬 {}", title("Video")),
        "voice" => "🎤 Tin nhắn thoại".into(),
        "sticker" => "Sticker".into(),
        "gif" => "GIF".into(),
        "link" => format!("🔗 {}", a.title.clone().or(a.url.clone()).unwrap_or_else(|| "Link".into())),
        "location" => format!("📍 {}", title("Vị trí")),
        "card" => format!("👤 {}", title("Danh thiếp")),
        _ => a.title.clone().unwrap_or_else(|| m.text.clone()),
    }
}

fn first_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn refresh_thread_last(s: &mut Store, thread_id: &str) {
    let Some(last) = s.messages.get(thread_id).and_then(|a| a.last()).cloned() else { return };
    let Some(t) = s.threads.get_mut(thread_id) else { return };
    t.last_ts = last.ts;
    let who = if t.group && !last.mine { format!("{}: ", last.from_name) } else { String::new() };
    t.last = who + &first_chars(&preview_of(&last), 200);
    t.last_self = Some(last.mine);
    t.last_status = if last.mine { last.status.clone() } else { None };
}

fn to_message(s: &Store, m: &Msg) -> ZaloMessage {
    let d = &m.data;
    let group = m.kind == ThreadType::Group;
    let content = d.get("content").cloned().unwrap_or(Value::Null);
    let msg_type = jstr(d.get("msgType"));
    let att = parse_attachment(&msg_type, &content, &s.stickers);
    let uid_from = jstr(d.get("uidFrom"));
    let from_id = if m.is_self { s.state.me.as_ref().map(|me| me.id.clone()).unwrap_or_else(|| uid_from.clone()) } else { uid_from.clone() };
    let q = d.get("quote").filter(|q| truthy(Some(q)));
    let mentions: Option<Vec<MentionRef>> = d.get("mentions").and_then(Value::as_array).map(|list| {
        list.iter().map(|x| MentionRef { uid: jstr(x.get("uid")), pos: jnum(x.get("pos")) as i64, len: jnum(x.get("len")) as i64 }).collect()
    });
    let d_name = d.get("dName").and_then(Value::as_str).filter(|n| !n.is_empty());
    let ts = jnum(d.get("ts"));
    let attach_text = |q: &Value| if truthy(q.get("attach")) { "[tệp đính kèm]".to_owned() } else { String::new() };
    let qmsg = |q: &Value| q.get("msg").filter(|v| truthy(Some(v))).map(|v| jstr(Some(v)));
    ZaloMessage {
        id: jstr(d.get("msgId")),
        cli_msg_id: jstr(d.get("cliMsgId")),
        thread_id: m.thread_id.clone(),
        group,
        from_id,
        from_name: if m.is_self {
            "Tôi".into()
        } else {
            d_name.map(str::to_owned).or_else(|| s.names.get(&uid_from).filter(|n| !n.is_empty()).cloned()).unwrap_or_else(|| uid_from.clone())
        },
        mine: m.is_self,
        ts: if ts.is_finite() && ts != 0.0 { ts as i64 } else { now_ms() },
        kind: msg_type.clone(),
        text: content_text(att.as_ref(), &content),
        att,
        mentions: mentions.filter(|m| !m.is_empty()),
        quote: q.filter(|q| truthy(q.get("msg")) || truthy(q.get("attach"))).map(|q| {
            format!("{}: {}", jstr(q.get("fromD")), qmsg(q).unwrap_or_else(|| "[tệp đính kèm]".into()))
        }),
        reply: q.map(|q| Reply {
            id: jstr(q.get("globalMsgId")),
            from: q.get("fromD").map(|v| jstr(Some(v))).unwrap_or_default(),
            text: qmsg(q).unwrap_or_else(|| attach_text(q)),
        }),
        status: m.is_self.then(|| "sent".into()),
        reactions: None,
        recalled: None,
        raw: Some(Raw {
            content,
            msg_type,
            property_ext: d.get("propertyExt").cloned(),
            uid_from,
            id_to: jstr(d.get("idTo")),
            ttl: d.get("ttl").cloned(),
            st: d.get("st").cloned(),
            at: d.get("at").cloned(),
            cmd: d.get("cmd").cloned(),
        }),
    }
}

/// Store messages. `live`: just arrived (counts as unread).
fn ingest(list: Vec<Msg>, live: bool) {
    if list.is_empty() {
        return;
    }
    let win_focused = window_focused();
    let mut seen_now: IndexSet<String> = IndexSet::new();
    let mut stickers = Vec::new();
    let mut profiles = Vec::new();
    let mut touched: IndexSet<String> = IndexSet::new();
    {
        let mut s = store();
        for m in &list {
            let msg = to_message(&s, m);
            if !m.is_self
                && let Some(n) = m.data.get("dName").and_then(Value::as_str).filter(|n| !n.is_empty())
            {
                s.names.insert(msg.from_id.clone(), n.to_owned());
            }
            let arr = s.messages.entry(m.thread_id.clone()).or_default();
            if arr.iter().any(|x| x.id == msg.id) {
                continue;
            }
            arr.push(msg.clone());
            let n = arr.len();
            if n > 1 && arr[n - 2].ts > msg.ts {
                arr.sort_by_key(|x| x.ts);
            }
            if arr.len() > MAX_PER_THREAD {
                let extra = arr.len() - MAX_PER_THREAD;
                arr.drain(..extra);
            }
            let replied_later = arr.iter().any(|x| x.mine && x.ts > msg.ts);
            let name_hint = s.names.get(&m.thread_id).cloned();
            let avatar_hint = s.avatars.get(&m.thread_id).cloned();
            let t = s.threads.entry(m.thread_id.clone()).or_insert_with(|| ZaloThread { id: m.thread_id.clone(), group: msg.group, ..Default::default() });
            t.contact = None;
            if t.name.is_empty() && !msg.group && !m.is_self
                && let Some(n) = m.data.get("dName").and_then(Value::as_str).filter(|n| !n.is_empty())
            {
                t.name = n.to_owned();
            }
            if t.name.is_empty() {
                t.name = name_hint.unwrap_or_default();
            }
            if t.avatar.is_none() && avatar_hint.is_some() {
                t.avatar = avatar_hint;
            }
            if msg.ts >= t.last_ts {
                refresh_thread_last(&mut s, &m.thread_id);
            }
            // replayed history: unread if it came in while the app was away and I haven't replied since
            let away = !live && s.away_from > 0 && msg.ts > s.away_from && !replied_later;
            let focused = win_focused && s.active.as_deref() == Some(m.thread_id.as_str());
            let t = s.threads.get_mut(&m.thread_id).expect("inserted above");
            if msg.mine && msg.ts >= t.last_ts {
                t.unread = Some(0);
            } else if (live || away) && !msg.mine {
                if focused {
                    seen_now.insert(m.thread_id.clone());
                } else {
                    t.unread = Some(t.unread.unwrap_or(0) + 1);
                }
            }
            if let Some(a) = &msg.att
                && a.kind == "sticker"
                && a.url.is_none()
                && let Some(st) = &a.sticker
            {
                stickers.push((m.thread_id.clone(), msg.id.clone(), st.id));
            }
            if msg.group && !m.is_self && !s.avatars.contains_key(&msg.from_id) {
                profiles.push(msg.from_id.clone());
            }
            touched.insert(m.thread_id.clone());
        }
    }
    for t in seen_now {
        mark_seen(&t);
    }
    for (thread, msg_id, sticker) in stickers {
        spawn(resolve_sticker(thread, msg_id, sticker));
    }
    for uid in profiles {
        want_profile(uid);
    }
    let ids: Vec<String> = touched.into_iter().collect();
    changed(ids.clone());
    if live && !ids.is_empty() {
        crate::zalo_tasks::on_ingest(ids);
    }
}

/// Conversations with something addressed to me since `since`: every personal chat with an
/// incoming message, and groups where someone @mentioned me or replied to me — with my own later
/// messages, so it's clear what I answered.
pub fn work_feed(since: i64, max_threads: usize, max_msgs: usize) -> Vec<WorkThread> {
    let s = store();
    let me = s.state.me.as_ref().map(|m| m.id.clone());
    let mut out = Vec::new();
    for t in s.threads.values() {
        let Some(arr) = s.messages.get(&t.id).filter(|a| !a.is_empty()) else { continue };
        if arr[arr.len() - 1].ts < since {
            continue;
        }
        let mine: IndexSet<&str> = arr.iter().filter(|m| m.mine).map(|m| m.id.as_str()).collect();
        let recent: Vec<&ZaloMessage> = arr.iter().filter(|m| m.ts >= since && m.recalled != Some(true)).collect();
        let to_me = |m: &ZaloMessage| {
            !m.mine
                && (!t.group
                    || m.mentions.as_ref().is_some_and(|l| l.iter().any(|x| Some(&x.uid) == me.as_ref()))
                    || m.reply.as_ref().is_some_and(|r| mine.contains(r.id.as_str())))
        };
        let Some(first) = recent.iter().position(|m| to_me(m)) else { continue };
        let pick: Vec<&&ZaloMessage> = recent[first..].iter().filter(|m| !t.group || m.mine || to_me(m)).collect();
        let msgs = pick[pick.len().saturating_sub(max_msgs)..]
            .iter()
            .map(|m| {
                let reply = m.reply.as_ref().map(|r| format!("[trả lời {}: \"{}\"] ", r.from, first_chars(&r.text, 80))).unwrap_or_default();
                let body = if m.text.is_empty() { preview_of(m) } else { m.text.clone() };
                WorkMsg {
                    id: m.id.clone(),
                    ts: m.ts,
                    from: if m.mine { "Tôi".into() } else { m.from_name.clone() },
                    from_id: m.from_id.clone(),
                    mine: m.mine,
                    to_me: to_me(m),
                    text: first_chars(&(reply + &body), 600),
                }
            })
            .collect();
        out.push(WorkThread { thread_id: t.id.clone(), name: if t.name.is_empty() { t.id.clone() } else { t.name.clone() }, group: t.group, msgs });
    }
    out.sort_by_key(|t| std::cmp::Reverse(t.msgs.last().map(|m| m.ts).unwrap_or(0)));
    out.truncate(max_threads);
    out
}

pub fn self_id() -> Option<String> {
    store().state.me.as_ref().map(|m| m.id.clone())
}

/// A user's avatar url, if known (queues a profile fetch otherwise).
pub fn avatar_of(user_id: &str) -> Option<String> {
    let a = store().avatars.get(user_id).cloned();
    if a.is_none() {
        want_profile(user_id.to_owned());
    }
    a
}

/* ---------------- profiles & stickers, fetched lazily ---------------- */

fn want_profile(uid: String) {
    if api_any().is_none() {
        return;
    }
    let mut s = store();
    if !s.profile_queue.insert(uid) || s.profile_timer {
        return;
    }
    s.profile_timer = true;
    spawn(async {
        tokio::time::sleep(Duration::from_millis(800)).await;
        flush_profiles().await;
    });
}

async fn flush_profiles() {
    let ids: Vec<String> = {
        let mut s = store();
        s.profile_timer = false;
        s.profile_queue.iter().filter(|id| !s.avatars.contains_key(*id)).take(100).cloned().collect()
    };
    let Some(a) = api_any() else { return };
    if ids.is_empty() {
        return;
    }
    let Ok(r) = a.get_user_info(&ids).await else { return };
    {
        let mut s = store();
        for (k, p) in r["changed_profiles"].as_object().into_iter().flatten() {
            let id = k.strip_suffix("_0").unwrap_or(k).to_owned();
            let avatar = vstr(p.get("avatar"));
            let name = p.get("displayName").and_then(Value::as_str).filter(|n| !n.is_empty()).or_else(|| p.get("zaloName").and_then(Value::as_str)).map(str::to_owned);
            if let Some(av) = &avatar {
                s.avatars.insert(id.clone(), av.clone());
            }
            if let Some(n) = name.clone().filter(|n| !n.is_empty()) {
                s.names.insert(id.clone(), n);
            }
            if let Some(t) = s.threads.get_mut(&id) {
                if avatar.is_some() {
                    t.avatar = avatar;
                }
                if t.name.is_empty() {
                    t.name = name.unwrap_or_default();
                }
            }
        }
    }
    changed(all_thread_ids());
}

async fn resolve_sticker(thread_id: String, msg_id: String, sticker_id: i64) {
    let Some(a) = api_any() else { return };
    if !store().stickers.contains_key(&sticker_id) {
        let Ok(list) = a.get_stickers_detail(&[sticker_id]).await else { return };
        let url = list.first().and_then(|d| vstr(d.get("stickerWebpUrl")).or_else(|| vstr(d.get("stickerUrl"))));
        if let Some(url) = url {
            store().stickers.insert(sticker_id, url);
        }
    }
    let done = {
        let mut s = store();
        let url = s.stickers.get(&sticker_id).cloned();
        match (url, s.messages.get_mut(&thread_id).and_then(|a| a.iter_mut().find(|m| m.id == msg_id)).and_then(|m| m.att.as_mut())) {
            (Some(url), Some(att)) => {
                att.url = Some(url);
                true
            }
            _ => false,
        }
    };
    if done {
        changed([thread_id]);
    }
}

/* ---------------- live events: reactions, recalls, seen, typing ---------------- */

fn find_msg<'a>(s: &'a mut Store, thread_id: &str, msg_id: &str) -> Option<&'a mut ZaloMessage> {
    s.messages.get_mut(thread_id)?.iter_mut().find(|m| m.id == msg_id)
}

fn set_reaction(m: &mut ZaloMessage, uid: &str, icon: &str) {
    let mut reactions = m.reactions.take().unwrap_or_default();
    for v in reactions.values_mut() {
        v.retain(|u| u != uid);
    }
    reactions.retain(|_, v| !v.is_empty());
    if !icon.is_empty() {
        reactions.entry(icon.to_owned()).or_default().push(uid.to_owned());
    }
    m.reactions = (!reactions.is_empty()).then_some(reactions);
}

fn apply_reaction(r: &Action) {
    let d = &r.data;
    let uid = jstr(d.get("uidFrom"));
    let icon = d["content"].get("rIcon").filter(|v| truthy(Some(v))).map(|v| jstr(Some(v))).unwrap_or_default();
    let mut hit = false;
    {
        let mut s = store();
        for target in d["content"]["rMsg"].as_array().into_iter().flatten() {
            if let Some(m) = find_msg(&mut s, &r.thread_id, &jstr(target.get("gMsgID"))) {
                set_reaction(m, &uid, &icon);
                hit = true;
            }
        }
    }
    if hit {
        changed([r.thread_id.clone()]);
    }
}

fn recall_locally(m: &mut ZaloMessage) {
    m.recalled = Some(true);
    m.text = "Tin nhắn đã được thu hồi".into();
    m.att = None;
    m.reply = None;
}

fn apply_undo(u: &Action) {
    let id = jstr(u.data["content"].get("globalMsgId"));
    {
        let mut s = store();
        let Some(m) = find_msg(&mut s, &u.thread_id, &id) else { return };
        recall_locally(m);
        m.reactions = None;
        refresh_thread_last(&mut s, &u.thread_id);
    }
    changed([u.thread_id.clone()]);
}

/// My messages up to `msg_id` in this thread were read by the other side.
fn mark_mine_seen(thread_id: &str, msg_id: &str) {
    {
        let mut s = store();
        let Some(arr) = s.messages.get_mut(thread_id) else { return };
        let up_to = arr.iter().find(|m| m.id == msg_id).map(|m| m.ts).unwrap_or(i64::MAX);
        for m in arr.iter_mut() {
            if m.mine && m.ts <= up_to && m.status.as_deref() == Some("sent") {
                m.status = Some("seen".into());
            }
        }
        refresh_thread_last(&mut s, thread_id);
    }
    changed([thread_id.to_owned()]);
}

/// Tell Zalo (and the sender) we read this conversation.
fn mark_seen(thread_id: &str) {
    let (was_unread, online, group, unseen) = {
        let mut s = store();
        let mut was = false;
        if let Some(t) = s.threads.get_mut(thread_id)
            && t.unread.unwrap_or(0) > 0
        {
            t.unread = Some(0);
            was = true;
        }
        let group = s.threads.get(thread_id).is_some_and(|t| t.group);
        let list: Vec<&ZaloMessage> = s.messages.get(thread_id).map(|a| a.iter().filter(|m| !m.mine && m.raw.is_some()).collect()).unwrap_or_default();
        let unseen: Vec<SeenMsg> = list[list.len().saturating_sub(20)..]
            .iter()
            .map(|m| {
                let r = m.raw.as_ref().expect("filtered");
                SeenMsg {
                    msg_id: m.id.clone(),
                    cli_msg_id: m.cli_msg_id.clone(),
                    uid_from: r.uid_from.clone(),
                    id_to: r.id_to.clone(),
                    msg_type: r.msg_type.clone(),
                    st: r.st.clone(),
                    at: r.at.clone(),
                    cmd: r.cmd.clone(),
                }
            })
            .collect();
        (was, s.state.status == "online", group, unseen)
    };
    if was_unread {
        changed([thread_id.to_owned()]);
    }
    let Some(a) = api_any() else { return };
    if !online || unseen.is_empty() {
        return;
    }
    let kind = if group { ThreadType::Group } else { ThreadType::User };
    spawn(async move {
        let _ = a.send_seen_event(&unseen, kind).await;
    });
}

/* ---------------- session ---------------- */

async fn save_creds(c: Credentials) {
    let Ok(raw) = serde_json::to_vec(&c) else { return };
    let body = match crate::secure::seal(&raw) {
        Ok(enc) => [b"E1".as_slice(), &enc].concat(),
        Err(_) => [b"P1".as_slice(), &raw].concat(),
    };
    let _ = core::write_atomic(cred_file(), body).await;
}

fn read_creds() -> Option<Credentials> {
    let b = std::fs::read(cred_file()).ok()?;
    let (tag, rest) = b.split_at_checked(2)?;
    let raw = if tag == b"E1" { crate::secure::open(rest).ok()? } else { rest.to_vec() };
    serde_json::from_slice(&raw).ok()
}

fn after_login(a: Arc<Api>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let listener = match Listener::new(a.clone(), tx) {
        Ok(l) => l,
        Err(e) => return set_state(|s| {
            s.status = "error";
            s.error = Some(format!("{e:#}"));
        }),
    };
    let id = NEXT_SESSION.fetch_add(1, Ordering::SeqCst);
    *SESSION.lock() = Some(Arc::new(Session { id, api: a.clone(), listener: listener.clone() }));
    {
        let mut s = store();
        s.retries = 0;
        s.away_from = s.synced_at;
    }
    let uid = a.uid.clone();
    set_state(|s| {
        s.status = "online";
        s.qr = None;
        s.error = None;
        let prev = s.me.take().unwrap_or_default();
        s.me = Some(ZaloSelf { id: uid.clone(), name: prev.name, avatar: prev.avatar });
    });
    let acc = a.clone();
    spawn(async move {
        if let Ok(r) = acc.fetch_account_info().await {
            let p = &r["profile"];
            let name = p.get("displayName").and_then(Value::as_str).filter(|n| !n.is_empty()).or_else(|| p.get("zaloName").and_then(Value::as_str)).unwrap_or_default().to_owned();
            let avatar = p.get("avatar").and_then(Value::as_str).unwrap_or_default().to_owned();
            set_state(|s| s.me = Some(ZaloSelf { id: uid, name, avatar }));
        }
    });
    let n = a.clone();
    spawn(async move { load_names(&n).await });
    let p = a.clone();
    spawn(async move { load_pins(&p).await });
    spawn(run_events(id, Arc::downgrade(&listener), rx));
    if let Err(e) = listener.start(true) {
        set_state(|s| {
            s.status = "error";
            s.error = Some(format!("{e:#}"));
        });
    }
}

fn is_current(id: u64) -> bool {
    session().is_some_and(|s| s.id == id)
}

async fn run_events(id: u64, listener: Weak<Listener>, mut rx: mpsc::UnboundedReceiver<Event>) {
    while let Some(ev) = rx.recv().await {
        match ev {
            Event::CipherKey => {
                if is_current(id)
                    && let Some(l) = listener.upgrade()
                {
                    request_replay(&l);
                }
            }
            Event::Message(m) => ingest(vec![m], true),
            Event::OldMessages(list, kind) => {
                let oldest = list.iter().fold(None::<&Msg>, |x, y| match x {
                    Some(x) if jnum(x.data.get("ts")) <= jnum(y.data.get("ts")) => Some(x),
                    _ => Some(y),
                });
                let oldest = oldest.map(|m| jstr(m.data.get("msgId")));
                let n = list.len();
                ingest(list, false);
                if n > 0 {
                    let i = if kind == ThreadType::User { 0 } else { 1 };
                    let more = {
                        let mut s = store();
                        s.replay_pages[i] += 1;
                        s.replay_pages[i] < OLD_PAGES
                    };
                    if more && let Some(l) = listener.upgrade() {
                        l.request_old_messages(kind, oldest);
                    }
                }
            }
            Event::Reaction(r) => apply_reaction(&r),
            Event::OldReactions(list) => list.iter().for_each(apply_reaction),
            Event::Undo(u) => apply_undo(&u),
            Event::Seen(list) => {
                for s in list.iter().filter(|s| !s.is_self) {
                    mark_mine_seen(&s.thread_id, &s.msg_id);
                }
            }
            Event::Typing(t) => {
                let name = store().names.get(&t.uid).cloned().unwrap_or_default();
                emit("zalo:typing", (ZaloTyping { thread_id: t.thread_id, uid: t.uid, name },));
            }
            Event::Closed(code) => {
                on_closed(id, code);
                break;
            }
            Event::Error(e) => {
                if cfg!(debug_assertions) {
                    eprintln!("zalo listener: {e}");
                }
            }
        }
    }
}

fn on_closed(id: u64, code: u16) {
    if !is_current(id) {
        return;
    }
    // 3000: the account opened Zalo Web somewhere else — only one web session may listen
    if code == 3000 {
        return set_state(|s| {
            s.status = "error";
            s.error = Some("Zalo Web đang mở ở nơi khác nên phiên này bị ngắt. Bấm Kết nối lại.".into());
        });
    }
    let retries = {
        let mut s = store();
        (s.retries < 5).then(|| {
            s.retries += 1;
            s.retries
        })
    };
    let Some(retries) = retries else {
        return set_state(|s| {
            s.status = "error";
            s.error = Some(format!("Mất kết nối Zalo ({code})."));
        });
    };
    set_state(|s| {
        s.status = "connecting";
        s.error = None;
    });
    let h = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(2000 * retries as u64)).await;
        RETRY.lock().take();
        reconnect(true).await;
    });
    if let Some(old) = RETRY.lock().replace(h.inner().abort_handle()) {
        old.abort();
    }
}

fn request_replay(l: &Listener) {
    store().replay_pages = [0, 0];
    l.request_old_messages(ThreadType::User, None);
    l.request_old_messages(ThreadType::Group, None);
    l.request_old_reactions(ThreadType::User);
    l.request_old_reactions(ThreadType::Group);
}

/// "Đồng bộ tất cả": names, pins, the socket replay again, and the latest page of every group.
/// Returns how many new messages came in.
pub async fn sync_all() -> anyhow::Result<i64> {
    let a = need()?;
    let total = || store().messages.values().map(Vec::len).sum::<usize>() as i64;
    let before = total();
    tokio::join!(load_names(&a), load_pins(&a));
    if let Some(s) = session() {
        request_replay(&s.listener);
    }
    let groups: Vec<String> = store().threads.values().filter(|t| t.group).map(|t| t.id.clone()).collect();
    for chunk in groups.chunks(4) {
        let pages = futures_util::future::join_all(chunk.iter().map(|id| a.get_cloud_message(id, None, false))).await;
        for (_, msgs) in pages.into_iter().flatten() {
            ingest(msgs, false);
        }
    }
    Ok(total() - before)
}

/// Friend and group names / avatars, so threads show who they are.
async fn load_names(a: &Api) {
    if let Ok(list) = a.get_all_friends().await {
        {
            let mut s = store();
            s.friends.clear();
            for f in &list {
                let id = jstr(f.get("userId"));
                s.friends.insert(id.clone());
                let name = f.get("displayName").and_then(Value::as_str).filter(|n| !n.is_empty()).or_else(|| f.get("zaloName").and_then(Value::as_str)).unwrap_or_default();
                s.names.insert(id.clone(), name.to_owned());
                if let Some(av) = f.get("avatar").and_then(Value::as_str).filter(|v| !v.is_empty()) {
                    s.avatars.insert(id, av.to_owned());
                }
            }
            let Store { threads, names, avatars, .. } = &mut *s;
            for t in threads.values_mut().filter(|t| !t.group) {
                if let Some(n) = names.get(&t.id) {
                    t.name = n.clone();
                }
                if let Some(av) = avatars.get(&t.id) {
                    t.avatar = Some(av.clone());
                }
            }
        }
        changed(all_thread_ids());
    }
    let Ok(groups) = a.get_all_groups().await else { return };
    let ids: Vec<String> = groups["gridVerMap"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    for chunk in ids.chunks(50) {
        let Ok(info) = a.get_group_info(chunk).await else { return };
        let mut s = store();
        for (gid, g) in info["gridInfoMap"].as_object().into_iter().flatten() {
            let name = jstr(g.get("name"));
            let avt = vstr(g.get("avt"));
            s.names.insert(gid.clone(), name.clone());
            if let Some(av) = &avt {
                s.avatars.insert(gid.clone(), av.clone());
            }
            let t = s.threads.entry(gid.clone()).or_insert_with(|| ZaloThread { id: gid.clone(), group: true, ..Default::default() });
            t.name = name;
            t.avatar = avt;
            t.members = g.get("totalMember").and_then(Value::as_i64);
        }
    }
    changed(all_thread_ids());
}

async fn load_pins(a: &Api) {
    let Ok(r) = a.get_pin_conversations().await else { return };
    let pinned: IndexMap<String, bool> = r["conversations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|c| (c.strip_prefix(['u', 'g']).unwrap_or(c).to_owned(), c.starts_with('g')))
        .collect();
    let mut want = Vec::new();
    {
        let mut s = store();
        for t in s.threads.values_mut() {
            t.pinned = pinned.contains_key(&t.id).then_some(true);
        }
        for (id, group) in &pinned {
            if !s.threads.contains_key(id) {
                let t = ZaloThread {
                    id: id.clone(),
                    group: *group,
                    name: s.names.get(id).cloned().unwrap_or_default(),
                    avatar: s.avatars.get(id).cloned(),
                    pinned: Some(true),
                    ..Default::default()
                };
                s.threads.insert(id.clone(), t);
            }
            if !group && !s.avatars.contains_key(id) {
                want.push(id.clone());
            }
        }
    }
    for id in want {
        want_profile(id);
    }
    changed(pinned.into_keys());
}

/// Start: log in with the saved session, if any.
pub fn init() {
    drop(store());
    if read_creds().is_some() {
        spawn(async {
            reconnect(false).await;
        });
    }
}

pub async fn reconnect(auto: bool) -> ZaloState {
    if let Some(h) = RETRY.lock().take() {
        h.abort();
    }
    if !auto {
        store().retries = 0;
    }
    let Some(creds) = read_creds() else {
        set_state(|s| s.status = "off");
        return state();
    };
    let generation = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    stop_listener();
    set_state(|s| {
        s.status = "connecting";
        s.error = None;
    });
    let r = api::login(&creds).await;
    if GEN.load(Ordering::SeqCst) == generation {
        match r {
            Ok(a) => after_login(a),
            Err(e) => set_state(|s| {
                s.status = "error";
                s.error = Some(format!("Không đăng nhập lại được: {e}. Hãy đăng nhập lại bằng QR."));
            }),
        }
    }
    state()
}

fn on_qr_event(generation: u64, ev: QrEvent) {
    if GEN.load(Ordering::SeqCst) != generation {
        return;
    }
    match ev {
        QrEvent::Generated { image } => set_state(|s| {
            s.status = "qr";
            s.qr = Some(format!("data:image/png;base64,{image}"));
            s.scanned = None;
        }),
        QrEvent::Expired => set_state(|s| {
            s.status = "qr";
            s.qr = None;
            s.error = Some("Mã QR đã hết hạn.".into());
        }),
        QrEvent::Scanned { display_name } => set_state(|s| s.scanned = Some(display_name)),
        QrEvent::Declined => set_state(|s| {
            s.status = "off";
            s.qr = None;
            s.error = Some("Đã từ chối đăng nhập trên điện thoại.".into());
        }),
        QrEvent::GotLoginInfo(c) => spawn(save_creds(c)),
    }
}

pub async fn login_qr() {
    let generation = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    stop_listener();
    set_state(|s| {
        s.status = "qr";
        s.qr = None;
        s.error = None;
    });
    let task = tauri::async_runtime::spawn(api::login_qr(move |ev| on_qr_event(generation, ev)));
    if let Some(old) = QR_ABORT.lock().replace(task.inner().abort_handle()) {
        old.abort();
    }
    let r = task.await;
    if GEN.load(Ordering::SeqCst) != generation {
        return;
    }
    QR_ABORT.lock().take();
    let err = match r {
        Ok(Ok(a)) => return after_login(a),
        Ok(Err(e)) => e.to_string(),
        Err(_) => api::QR_ABORTED.to_owned(),
    };
    if state().status == "qr" {
        set_state(|s| {
            s.status = if s.error.is_some() { "qr" } else { "off" };
            s.qr = None;
            if s.error.is_none() {
                s.error = Some(err);
            }
        });
    }
}

pub fn cancel_login() {
    if let Some(h) = QR_ABORT.lock().take() {
        h.abort();
        GEN.fetch_add(1, Ordering::SeqCst);
    }
    set_state(|s| {
        s.status = "off";
        s.qr = None;
        s.scanned = None;
        s.error = None;
    });
}

fn stop_listener() {
    if let Some(s) = SESSION.lock().take() {
        s.listener.stop();
    }
}

/// Forget the session and everything cached.
pub async fn logout() {
    if let Some(h) = RETRY.lock().take() {
        h.abort();
    }
    GEN.fetch_add(1, Ordering::SeqCst);
    stop_listener();
    {
        let mut s = store();
        s.threads.clear();
        s.messages.clear();
        s.names.clear();
        s.avatars.clear();
        s.friends.clear();
    }
    let _ = tokio::fs::remove_dir_all(dir()).await;
    set_state(|s| {
        s.status = "off";
        s.me = None;
        s.qr = None;
        s.error = None;
    });
    emit("zalo:changed", (Vec::<String>::new(),));
}

/* ---------------- reading ---------------- */

fn type_of(thread_id: &str, group: Option<bool>) -> ThreadType {
    let g = group.unwrap_or_else(|| store().threads.get(thread_id).is_some_and(|t| t.group));
    if g { ThreadType::Group } else { ThreadType::User }
}

pub fn list_threads(query: &str, limit: usize) -> Vec<ZaloThread> {
    let q = query.trim().to_lowercase();
    let s = store();
    let mut list: Vec<ZaloThread> = s.threads.values().filter(|t| q.is_empty() || t.name.to_lowercase().contains(&q) || t.id.contains(&q)).cloned().collect();
    list.sort_by_key(|t| std::cmp::Reverse(t.last_ts));
    list.truncate(limit);
    list
}

/// Conversations for the Zalo tab: everything with a name, pinned and newest first.
pub fn ui_threads() -> Vec<ZaloThread> {
    let s = store();
    let mut list: Vec<ZaloThread> = s.threads.values().filter(|t| !t.name.is_empty() || t.last_ts != 0).cloned().collect();
    list.sort_by(|a, b| (b.pinned == Some(true)).cmp(&(a.pinned == Some(true))).then(b.last_ts.cmp(&a.last_ts)));
    list
}

/// Vietnamese collation, close to `localeCompare(…, 'vi')`: letters with breve / circumflex / horn
/// and đ sort after their base letter; tones (̀ ̉ ̃ ́ ̣) and case only break ties.
fn vi_key(s: &str) -> (Vec<u32>, Vec<u8>, Vec<u8>) {
    use unicode_normalization::UnicodeNormalization;
    let (mut primary, mut tones, mut case) = (Vec::new(), Vec::new(), Vec::new());
    for c in s.nfd() {
        let modifier = match c {
            '\u{0306}' => Some(1),
            '\u{0302}' => Some(2),
            '\u{031B}' => Some(3),
            _ => None,
        };
        let tone = match c {
            '\u{0300}' => Some(1),
            '\u{0309}' => Some(2),
            '\u{0303}' => Some(3),
            '\u{0301}' => Some(4),
            '\u{0323}' => Some(5),
            _ => None,
        };
        if let Some(m) = modifier {
            if let Some(p) = primary.last_mut() {
                *p += m;
            }
        } else if let Some(t) = tone {
            if let Some(x) = tones.last_mut() {
                *x = t;
            }
        } else {
            let (base, extra) = match c {
                'đ' => ('d', 1),
                'Đ' => ('D', 1),
                c => (c, 0),
            };
            let lower = base.to_lowercase().next().unwrap_or(base);
            primary.push(lower as u32 * 4 + extra);
            tones.push(0);
            case.push(u8::from(base != lower));
        }
    }
    (primary, tones, case)
}

fn vi_cmp(a: &str, b: &str) -> CmpOrdering {
    vi_key(a).cmp(&vi_key(b)).then_with(|| a.cmp(b))
}

/// Friends, for the contact list (with their thread if one exists).
pub fn contacts() -> Vec<ZaloThread> {
    let s = store();
    let mut list: Vec<ZaloThread> = s
        .friends
        .iter()
        .map(|id| {
            s.threads.get(id).cloned().unwrap_or_else(|| ZaloThread {
                id: id.clone(),
                name: s.names.get(id).cloned().unwrap_or_else(|| id.clone()),
                avatar: s.avatars.get(id).cloned(),
                contact: Some(true),
                ..Default::default()
            })
        })
        .collect();
    drop(s);
    list.sort_by(|a, b| vi_cmp(&a.name, &b.name));
    list
}

pub fn get_messages(thread_id: &str, limit: usize, before: Option<i64>) -> Vec<ZaloMessage> {
    let s = store();
    let all = s.messages.get(thread_id).map(Vec::as_slice).unwrap_or_default();
    let list: Vec<&ZaloMessage> = match before.filter(|b| *b != 0) {
        Some(b) => all.iter().filter(|m| m.ts < b).collect(),
        None => all.iter().collect(),
    };
    list[list.len().saturating_sub(limit)..].iter().map(|m| (*m).clone()).collect()
}

/// Older messages of a group from Zalo's cloud (1-to-1 chats only have what the socket replayed).
pub async fn load_older(thread_id: &str, pages: usize) -> anyhow::Result<i64> {
    let a = need()?;
    let count = || store().messages.get(thread_id).map(Vec::len).unwrap_or(0) as i64;
    if !store().threads.get(thread_id).is_some_and(|t| t.group) {
        return Ok(0);
    }
    let before = count();
    let mut cursor = store().messages.get(thread_id).and_then(|a| a.first()).map(|m| m.id.clone());
    let mut is_old = false;
    for _ in 0..pages {
        let (r, msgs) = a.get_cloud_message(thread_id, cursor.as_deref(), is_old).await?;
        let empty = msgs.is_empty();
        ingest(msgs, false);
        if !truthy(r.get("hasMore")) || (empty && truthy(r.get("isFiltered"))) {
            break;
        }
        cursor = r.get("lastMsgId").map(|v| jstr(Some(v)));
        is_old = truthy(r.get("isOld"));
    }
    Ok(count() - before)
}

pub fn search_messages(query: &str, thread_id: Option<&str>, limit: usize) -> Vec<ZaloMessage> {
    let q = query.to_lowercase();
    let s = store();
    let mut list: Vec<ZaloMessage> = match thread_id {
        Some(t) => s.messages.get(t).map(|a| a.iter().collect::<Vec<_>>()).unwrap_or_default(),
        None => s.messages.values().flatten().collect(),
    }
    .into_iter()
    .filter(|m| m.text.to_lowercase().contains(&q) || m.from_name.to_lowercase().contains(&q))
    .cloned()
    .collect();
    list.sort_by_key(|m| std::cmp::Reverse(m.ts));
    list.truncate(limit);
    list
}

pub async fn thread_info(thread_id: &str) -> ZaloThreadInfo {
    let mut info = {
        let s = store();
        let t = s.threads.get(thread_id);
        ZaloThreadInfo {
            id: thread_id.to_owned(),
            name: t.map(|t| t.name.clone()).filter(|n| !n.is_empty()).or_else(|| s.names.get(thread_id).cloned().filter(|n| !n.is_empty())).unwrap_or_else(|| thread_id.to_owned()),
            avatar: t.and_then(|t| t.avatar.clone()).or_else(|| s.avatars.get(thread_id).cloned()),
            group: t.is_some_and(|t| t.group),
            members: t.and_then(|t| t.members),
            ..Default::default()
        }
    };
    let Some(a) = api_any() else { return info };
    if info.group {
        if let Ok(r) = a.get_group_info(&[thread_id.to_owned()]).await
            && let Some(g) = r["gridInfoMap"].get(thread_id)
        {
            info.members = g.get("totalMember").and_then(Value::as_i64);
            info.desc = vstr(g.get("desc"));
            info.avatar = vstr(g.get("fullAvt")).or_else(|| vstr(g.get("avt"))).or(info.avatar);
        }
    } else {
        let ids = [thread_id.to_owned()];
        let (p, o) = tokio::join!(a.get_user_info(&ids), a.last_online(thread_id));
        if let Some(p) = p.ok().and_then(|r| r["changed_profiles"].as_object().and_then(|m| m.values().next().cloned())) {
            info.avatar = vstr(p.get("avatar")).or(info.avatar);
            info.phone = vstr(p.get("phoneNumber"));
            info.desc = vstr(p.get("status"));
        }
        if let Ok(o) = o
            && truthy(o["settings"].get("show_online_status"))
        {
            let lo = jnum(o.get("lastOnline"));
            info.last_online = lo.is_finite().then_some(lo);
            let ms = lo * if lo < 1e12 { 1000.0 } else { 1.0 };
            info.online = Some(lo.is_finite() && lo != 0.0 && (now_ms() as f64 - ms) < 180_000.0);
        }
    }
    info
}

/* ---------------- sending & actions ---------------- */

fn quote_of(thread_id: &str, reply_to: Option<&str>) -> Option<Quote> {
    let mut s = store();
    let m = find_msg(&mut s, thread_id, reply_to?)?;
    let r = m.raw.as_ref()?;
    Some(Quote {
        content: r.content.clone(),
        msg_type: r.msg_type.clone(),
        property_ext: r.property_ext.clone(),
        uid_from: r.uid_from.clone(),
        msg_id: m.id.clone(),
        cli_msg_id: m.cli_msg_id.clone(),
        ts: m.ts.to_string(),
        ttl: r.ttl.clone(),
    })
}

pub async fn send_text(thread_id: &str, text: &str, group: Option<bool>, reply_to: Option<&str>) -> anyhow::Result<String> {
    let a = need()?;
    let quote = quote_of(thread_id, reply_to);
    let r = a.send_message(Outgoing { msg: text.to_owned(), quote, ..Default::default() }, thread_id, type_of(thread_id, group)).await?;
    Ok(r.message.as_ref().and_then(|m| m.get("msgId")).map(|v| jstr(Some(v))).unwrap_or_default())
}

pub async fn send_files(thread_id: &str, paths: Vec<String>, caption: String) -> anyhow::Result<()> {
    let a = need()?;
    let attachments = paths.into_iter().map(PathBuf::from).collect();
    a.send_message(Outgoing { msg: caption, attachments, ..Default::default() }, thread_id, type_of(thread_id, None)).await?;
    Ok(())
}

pub async fn send_sticker(thread_id: &str, s: ZaloSticker) -> anyhow::Result<()> {
    let a = need()?;
    store().stickers.insert(s.id, s.url.clone());
    a.send_sticker(s.id, s.cate_id, s.kind, thread_id, type_of(thread_id, None)).await?;
    Ok(())
}

pub async fn search_stickers(keyword: &str) -> anyhow::Result<Vec<ZaloSticker>> {
    let a = need()?;
    let k = keyword.trim();
    let mut ids = a.get_stickers(if k.is_empty() { "hi" } else { k }).await?;
    ids.truncate(48);
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let list = a.get_stickers_detail(&ids).await?;
    let num = |v: Option<&Value>| jnum(v) as i64;
    Ok(list
        .iter()
        .map(|d| ZaloSticker {
            id: num(d.get("id")),
            cate_id: num(d.get("cateId")),
            kind: num(d.get("type")),
            url: vstr(d.get("stickerWebpUrl")).or_else(|| vstr(d.get("stickerUrl"))).unwrap_or_default(),
        })
        .filter(|s| !s.url.is_empty())
        .collect())
}

fn msg_ids(thread_id: &str, msg_id: &str) -> Option<(String, String, bool, String)> {
    let mut s = store();
    let m = find_msg(&mut s, thread_id, msg_id)?;
    Some((m.id.clone(), m.cli_msg_id.clone(), m.mine, m.raw.as_ref().map(|r| r.uid_from.clone()).unwrap_or_else(|| m.from_id.clone())))
}

pub async fn react(thread_id: &str, msg_id: &str, icon: &str) -> anyhow::Result<()> {
    let a = need()?;
    let (id, cli, _, _) = msg_ids(thread_id, msg_id).ok_or_else(|| anyhow::anyhow!("Không tìm thấy tin nhắn."))?;
    a.add_reaction(icon, &id, &cli, thread_id, type_of(thread_id, None)).await?;
    // the listener echoes my reaction too; apply it now so the chip shows at once
    let me = self_id().unwrap_or_default();
    if let Some(m) = find_msg(&mut store(), thread_id, msg_id) {
        set_reaction(m, &me, icon);
    }
    changed([thread_id.to_owned()]);
    Ok(())
}

/// Recall my message for everyone.
pub async fn recall(thread_id: &str, msg_id: &str) -> anyhow::Result<()> {
    let a = need()?;
    let (id, cli, mine, _) = msg_ids(thread_id, msg_id).filter(|m| m.2).ok_or_else(|| anyhow::anyhow!("Chỉ thu hồi được tin nhắn của bạn."))?;
    debug_assert!(mine);
    a.undo(&id, &cli, thread_id, type_of(thread_id, None)).await?;
    {
        let mut s = store();
        if let Some(m) = find_msg(&mut s, thread_id, msg_id) {
            recall_locally(m);
        }
        refresh_thread_last(&mut s, thread_id);
    }
    changed([thread_id.to_owned()]);
    Ok(())
}

/// Delete a message on my side only.
pub async fn delete_for_me(thread_id: &str, msg_id: &str) -> anyhow::Result<()> {
    let a = need()?;
    let Some((id, cli, _, uid_from)) = msg_ids(thread_id, msg_id) else { return Ok(()) };
    a.delete_message(thread_id, type_of(thread_id, None), &id, &cli, &uid_from, true).await?;
    {
        let mut s = store();
        if let Some(arr) = s.messages.get_mut(thread_id) {
            arr.retain(|m| m.id != msg_id);
        }
        refresh_thread_last(&mut s, thread_id);
    }
    changed([thread_id.to_owned()]);
    Ok(())
}

pub async fn forward(from_thread: &str, msg_id: &str, to_thread: &str) -> anyhow::Result<()> {
    let a = need()?;
    let m = {
        let mut s = store();
        find_msg(&mut s, from_thread, msg_id).cloned()
    };
    let m = m.ok_or_else(|| anyhow::anyhow!("Không tìm thấy tin nhắn."))?;
    let kind = type_of(to_thread, None);
    let Some(content) = m.raw.as_ref().and_then(|r| r.content.as_str()) else {
        // attachments: send the link again (Zalo's forward call takes text only)
        let text = m.att.as_ref().and_then(|a| a.url.clone()).unwrap_or(m.text.clone());
        a.send_message(Outgoing { msg: text, ..Default::default() }, to_thread, kind).await?;
        return Ok(());
    };
    let r = a.forward_message(content, &[to_thread.to_owned()], kind).await?;
    if let Some(f) = r["fail"].as_array().and_then(|f| f.first()) {
        anyhow::bail!("Chuyển tiếp lỗi ({}).", jstr(f.get("error_code")));
    }
    Ok(())
}

pub fn typing(thread_id: &str) {
    let Some(a) = api_any() else { return };
    {
        let mut s = store();
        if now_ms() - s.last_typing < 3000 {
            return;
        }
        s.last_typing = now_ms();
    }
    let kind = type_of(thread_id, None);
    let id = thread_id.to_owned();
    spawn(async move {
        let _ = a.send_typing_event(&id, kind).await;
    });
}

/// "HH:MM:SS dd/mm/yyyy" in local time (`toLocaleString('vi-VN', {hour12: false})`).
pub fn fmt_time(ts: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ts).single().map(|d| d.format("%H:%M:%S %d/%m/%Y").to_string()).unwrap_or_default()
}

/* ---------------- commands ---------------- */

#[tauri::command]
pub async fn zalo_state() -> ZaloState {
    state()
}

#[tauri::command]
pub async fn zalo_login() {
    login_qr().await
}

#[tauri::command]
pub async fn zalo_cancel() {
    cancel_login()
}

#[tauri::command]
pub async fn zalo_reconnect() -> ZaloState {
    reconnect(false).await
}

#[tauri::command]
pub async fn zalo_logout() {
    logout().await
}

#[tauri::command]
pub async fn zalo_threads(query: Option<String>) -> Vec<ZaloThread> {
    list_threads(&query.unwrap_or_default(), 200)
}

#[tauri::command]
pub async fn zalo_messages(thread_id: String, limit: Option<u32>, before: Option<i64>) -> Vec<ZaloMessage> {
    get_messages(&thread_id, limit.unwrap_or(50) as usize, before)
}

#[tauri::command]
pub async fn zalo_sync_all() -> Res<i64> {
    Ok(sync_all().await?)
}

#[tauri::command]
pub async fn zalo_load_older(thread_id: String) -> Res<i64> {
    Ok(load_older(&thread_id, 3).await?)
}

#[tauri::command]
pub async fn zalo_send(thread_id: String, text: String, reply_to: Option<String>) -> Res<String> {
    Ok(send_text(&thread_id, &text, None, reply_to.as_deref()).await?)
}

#[tauri::command]
pub async fn zalo_ui_threads() -> Vec<ZaloThread> {
    ui_threads()
}

#[tauri::command]
pub async fn zalo_contacts() -> Vec<ZaloThread> {
    contacts()
}

/// The conversation open in the tab (none: null): its messages are read as they come.
#[tauri::command]
pub async fn zalo_set_active(thread_id: Option<String>) {
    store().active = thread_id.clone();
    if let Some(t) = thread_id {
        mark_seen(&t);
    }
}

#[tauri::command]
pub async fn zalo_info(thread_id: String) -> ZaloThreadInfo {
    thread_info(&thread_id).await
}

#[tauri::command]
pub async fn zalo_send_files(thread_id: String, paths: Vec<String>, caption: Option<String>) -> Res<()> {
    Ok(send_files(&thread_id, paths, caption.unwrap_or_default()).await?)
}

#[tauri::command]
pub async fn zalo_send_sticker(thread_id: String, s: ZaloSticker) -> Res<()> {
    Ok(send_sticker(&thread_id, s).await?)
}

#[tauri::command]
pub async fn zalo_stickers(keyword: String) -> Res<Vec<ZaloSticker>> {
    Ok(search_stickers(&keyword).await?)
}

#[tauri::command]
pub async fn zalo_react(thread_id: String, msg_id: String, icon: String) -> Res<()> {
    Ok(react(&thread_id, &msg_id, &icon).await?)
}

#[tauri::command]
pub async fn zalo_recall(thread_id: String, msg_id: String) -> Res<()> {
    Ok(recall(&thread_id, &msg_id).await?)
}

#[tauri::command]
pub async fn zalo_delete_for_me(thread_id: String, msg_id: String) -> Res<()> {
    Ok(delete_for_me(&thread_id, &msg_id).await?)
}

#[tauri::command]
pub async fn zalo_forward(from_thread: String, msg_id: String, to_thread: String) -> Res<()> {
    Ok(forward(&from_thread, &msg_id, &to_thread).await?)
}

#[tauri::command]
pub async fn zalo_typing(thread_id: String) {
    typing(&thread_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn vietnamese_order_like_locale_compare() {
        // node: [...].sort((a, b) => a.localeCompare(b, 'vi'))
        let mut v = vec!["Đức", "Dung", "An", "Ăn", "Âu", "bảo", "Bao", "Ba", "1a", "Zed", "Ơn", "Ôn", "On", "ánh", "anh"];
        v.sort_by(|a, b| vi_cmp(a, b));
        assert_eq!(v, ["1a", "An", "anh", "ánh", "Ăn", "Âu", "Ba", "Bao", "bảo", "Dung", "Đức", "On", "Ôn", "Ơn", "Zed"]);
    }

    #[test]
    fn attachments_parse_like_zalo_ts() {
        let st = IndexMap::new();
        let photo = parse_attachment("chat.photo", &json!({ "href": "https://h", "thumb": "https://t", "params": "{\"hd\":\"https://hd\",\"width\":1920,\"height\":\"1080\"}" }), &st).unwrap();
        assert_eq!(photo.kind, "photo");
        assert_eq!(photo.url.as_deref(), Some("https://hd"));
        assert_eq!((photo.width, photo.height), (Some(1920.0), Some(1080.0)));
        assert_eq!(serde_json::to_value(&photo).unwrap(), json!({ "kind": "photo", "url": "https://hd", "thumb": "https://t", "width": 1920, "height": 1080 }));
        let file = parse_attachment("share.file", &json!({ "title": "a.PDF", "href": "https://f", "params": { "fileSize": "2048", "fileExt": "PDF" } }), &st).unwrap();
        assert_eq!((file.kind.as_str(), file.size, file.ext.as_deref()), ("file", Some(2048.0), Some("pdf")));
        let voice = parse_attachment("chat.voice", &json!({ "href": "https://v", "params": "{\"duration\":2500}" }), &st).unwrap();
        assert_eq!(voice.duration, Some(2.5));
        let sticker = parse_attachment("chat.sticker", &json!({ "id": 42, "catId": 7, "type": 3 }), &st).unwrap();
        assert_eq!(sticker.sticker, Some(StickerRef { id: 42, cate_id: 7, kind: 3 }));
        let card = parse_attachment("chat.recommended", &json!({ "action": "recommened.user", "title": "Bob", "params": "{\"phone\":\"0909\"}" }), &st).unwrap();
        assert_eq!((card.kind.as_str(), card.desc.as_deref()), ("card", Some("0909")));
        assert!(parse_attachment("webchat", &json!("hello"), &st).is_none());
        assert_eq!(content_text(Some(&file), &json!({})), "[file] a.PDF https://f");
        assert_eq!(content_text(None, &json!({})), "[tin nhắn]");
    }

    #[test]
    fn message_from_socket() {
        let s = Store::default();
        let m = listen::group_message(
            "me",
            json!({
                "msgId": "7300000000000000001", "cliMsgId": "1731", "uidFrom": "55", "idTo": "g1", "dName": "Lan",
                "ts": "1731999999999", "msgType": "webchat", "content": "chào", "ttl": 0, "st": 3, "at": 0, "cmd": 521,
                "quote": { "fromD": "Tôi", "msg": "hỏi", "globalMsgId": 99, "ownerId": 1 },
                "mentions": [{ "uid": "me", "pos": 0, "len": 3 }]
            }),
        );
        let z = to_message(&s, &m);
        let v = serde_json::to_value(&z).unwrap();
        assert_eq!(v["id"], "7300000000000000001");
        assert_eq!(v["fromName"], "Lan");
        assert_eq!(v["ts"], 1731999999999i64);
        assert_eq!(v["text"], "chào");
        assert_eq!(v["quote"], "Tôi: hỏi");
        assert_eq!(v["reply"], json!({ "id": "99", "from": "Tôi", "text": "hỏi" }));
        assert_eq!(v["mentions"], json!([{ "uid": "me", "pos": 0, "len": 3 }]));
        assert_eq!(v["raw"]["idTo"], "g1");
        assert!(v.get("status").is_none() && v.get("att").is_none());
        // cache round trip
        let back: ZaloMessage = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), v);
    }
}
