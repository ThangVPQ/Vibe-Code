//! The shapes the Zalo tab gets (src/shared/types.ts), also what cache.json holds.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

/// A JS number that is usually whole: written without ".0" when it is.
pub fn ser_num<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => s.serialize_i64(*f as i64),
        Some(f) => s.serialize_f64(*f),
        None => s.serialize_none(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZaloState {
    /// off | qr | connecting | online | error
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "self", skip_serializing_if = "Option::is_none")]
    pub me: Option<ZaloSelf>,
}

impl Default for ZaloState {
    fn default() -> Self {
        Self { status: "off", qr: None, scanned: None, error: None, me: None }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ZaloSelf {
    pub id: String,
    pub name: String,
    pub avatar: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZaloThread {
    pub id: String,
    pub group: bool,
    pub name: String,
    pub last_ts: i64,
    pub last: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_self: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StickerRef {
    pub id: i64,
    pub cate_id: i64,
    #[serde(rename = "type")]
    pub kind: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ZaloAttachment {
    /// photo | video | voice | file | sticker | gif | link | location | card | other
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "ser_num")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "ser_num")]
    pub height: Option<f64>,
    /// bytes
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "ser_num")]
    pub size: Option<f64>,
    /// seconds
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "ser_num")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<StickerRef>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Reply {
    pub id: String,
    pub from: String,
    pub text: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MentionRef {
    pub uid: String,
    pub pos: i64,
    pub len: i64,
}

/// What Zalo needs to quote a message / mark it seen.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Raw {
    pub content: Value,
    pub msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property_ext: Option<Value>,
    pub uid_from: String,
    pub id_to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub st: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZaloMessage {
    pub id: String,
    pub cli_msg_id: String,
    pub thread_id: String,
    pub group: bool,
    pub from_id: String,
    pub from_name: String,
    #[serde(rename = "self")]
    pub mine: bool,
    pub ts: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<Reply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub att: Option<ZaloAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<MentionRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reactions: Option<IndexMap<String, Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recalled: Option<bool>,
    /// my messages: sending | sent | seen | failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Raw>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZaloSticker {
    pub id: i64,
    pub cate_id: i64,
    #[serde(rename = "type")]
    pub kind: i64,
    pub url: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZaloThreadInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub group: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "ser_num")]
    pub last_online: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZaloTyping {
    pub thread_id: String,
    pub uid: String,
    pub name: String,
}

/// A message in [`super::work_feed`].
#[derive(Clone, Debug)]
pub struct WorkMsg {
    pub id: String,
    pub ts: i64,
    pub from: String,
    pub from_id: String,
    pub mine: bool,
    /// sent to me: a personal chat, an @mention of me, or a reply to my message
    pub to_me: bool,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct WorkThread {
    pub thread_id: String,
    pub name: String,
    pub group: bool,
    pub msgs: Vec<WorkMsg>,
}
