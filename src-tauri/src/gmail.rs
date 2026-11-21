//! Gmail tab: a read-only view of the inbox over IMAP, signed in with a Google app password
//! (no Google Cloud project needed). The mailbox is opened with EXAMINE, so reading here never
//! marks mail as read. The password is kept in `<userData>/gmail.json`, sealed by `secure`.
//!
//! Speed: one IMAP connection is kept open and reused (a fresh one is made when Gmail has dropped
//! it), the list asks only for each message's ENVELOPE, and opened messages are cached in memory.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use anyhow::{Context, Result, anyhow};
use mailparse::{DispositionType, MailHeaderMap, ParsedMail};
use serde::Serialize;
use serde_json::{Value, json};

use crate::core::{Res, err, user_data};
use crate::secure;

const HOST: &str = "imap.gmail.com";
/// how many messages one page of the list loads (scrolling to the bottom loads the next page)
const PAGE_SIZE: u32 = 30;

type Session = imap::Session<native_tls::TlsStream<std::net::TcpStream>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSummary {
    uid: u32,
    /// display name, or the address when there is none
    from: String,
    from_addr: String,
    subject: String,
    /// ms since epoch, 0 when the Date header is missing or unreadable
    date: i64,
    seen: bool,
}

#[derive(Serialize, Clone)]
pub struct MailBody {
    uid: u32,
    from: String,
    to: String,
    subject: String,
    date: i64,
    html: Option<String>,
    text: Option<String>,
    attachments: Vec<String>,
}

/* ---------------- saved account ---------------- */

fn account_file() -> std::path::PathBuf {
    user_data().join("gmail.json")
}

fn saved_account() -> Option<(String, String)> {
    let j: Value = serde_json::from_str(&std::fs::read_to_string(account_file()).ok()?).ok()?;
    let email = j["email"].as_str()?.to_owned();
    let password = secure::open_str(j["password"].as_str()?).ok()?;
    Some((email, password))
}

fn connect(email: &str, password: &str) -> Result<Session> {
    let tls = native_tls::TlsConnector::new()?;
    let client = imap::connect((HOST, 993), HOST, &tls).context("không kết nối được tới imap.gmail.com")?;
    client.login(email, password).map_err(|(e, _)| {
        let detail = e.to_string();
        if detail.contains("Application-specific password required") {
            anyhow!("Đây là mật khẩu Google thường. Gmail chỉ nhận mật khẩu ứng dụng: làm theo bước 1–2 bên dưới để tạo, rồi dán mã 16 ký tự vào ô mật khẩu.")
        } else if detail.contains("Invalid credentials") {
            anyhow!("Sai email hoặc mật khẩu ứng dụng. Kiểm tra lại, hoặc tạo mật khẩu ứng dụng mới.")
        } else {
            anyhow!("Gmail từ chối đăng nhập: {detail}")
        }
    })
}

/* ---------------- the shared connection ---------------- */

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static BODIES: LazyLock<Mutex<HashMap<u32, MailBody>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `f` on the open connection (INBOX examined). If the kept connection fails (Gmail drops idle
/// ones), it is replaced by a fresh one and `f` runs once more.
fn with_inbox<T>(f: impl Fn(&mut Session) -> Result<T>) -> Result<T> {
    let mut guard = lock(&SESSION);
    if let Some(s) = guard.as_mut() {
        if let Ok(v) = f(s) {
            return Ok(v);
        }
        *guard = None;
    }
    let (email, password) = saved_account().ok_or_else(|| anyhow!("chưa đăng nhập Gmail"))?;
    let mut s = connect(&email, &password)?;
    s.examine("INBOX")?;
    let v = f(&mut s)?;
    *guard = Some(s);
    Ok(v)
}

/* ---------------- parsing ---------------- */

fn header(headers: &[mailparse::MailHeader], name: &str) -> String {
    headers.get_first_value(name).unwrap_or_default()
}

fn date_ms(headers: &[mailparse::MailHeader]) -> i64 {
    headers.get_first_value("Date").and_then(|d| mailparse::dateparse(&d).ok()).map_or(0, |s| s * 1000)
}

/// Envelope fields come raw, possibly RFC 2047 encoded ("=?UTF-8?B?...?="): decode them as a header would be.
fn decode(raw: Option<&[u8]>) -> String {
    let Some(raw) = raw else { return String::new() };
    let mut line = b"X: ".to_vec();
    line.extend_from_slice(raw);
    mailparse::parse_header(&line).map(|(h, _)| h.get_value()).unwrap_or_else(|_| String::from_utf8_lossy(raw).into_owned())
}

/// First text/html and text/plain parts, plus attachment file names.
fn walk(part: &ParsedMail, html: &mut Option<String>, text: &mut Option<String>, attachments: &mut Vec<String>) {
    let disposition = part.get_content_disposition();
    if disposition.disposition == DispositionType::Attachment {
        attachments.push(disposition.params.get("filename").or(part.ctype.params.get("name")).cloned().unwrap_or_else(|| "(không tên)".into()));
        return;
    }
    if part.subparts.is_empty() {
        let slot = match part.ctype.mimetype.as_str() {
            "text/html" => html,
            "text/plain" => text,
            _ => return,
        };
        if slot.is_none() {
            *slot = part.get_body().ok();
        }
        return;
    }
    for p in &part.subparts {
        walk(p, html, text, attachments);
    }
}

/* ---------------- commands ---------------- */

/// The signed-in address, or None.
#[tauri::command]
pub async fn gmail_state() -> Res<Option<String>> {
    Ok(saved_account().map(|(email, _)| email))
}

/// Checks the address + app password against Gmail, then saves them.
#[tauri::command]
pub async fn gmail_login(email: String, password: String) -> Res<String> {
    let email = email.trim().to_owned();
    // Google shows app passwords as "abcd efgh ijkl mnop"
    let password: String = password.chars().filter(|c| !c.is_whitespace()).collect();
    if email.is_empty() || password.is_empty() {
        return Err(err("Nhập email và mật khẩu ứng dụng"));
    }
    let (e, p) = (email.clone(), password.clone());
    let session = tokio::task::spawn_blocking(move || -> Result<Session> {
        let mut s = connect(&e, &p)?;
        s.examine("INBOX")?;
        Ok(s)
    })
    .await??;
    *lock(&SESSION) = Some(session);
    lock(&BODIES).clear();
    let saved = json!({ "email": email, "password": secure::seal_str(&password)? });
    std::fs::write(account_file(), serde_json::to_vec_pretty(&saved)?)?;
    Ok(email)
}

#[tauri::command]
pub async fn gmail_logout() -> Res<()> {
    if let Some(mut s) = lock(&SESSION).take() {
        let _ = s.logout();
    }
    lock(&BODIES).clear();
    match std::fs::remove_file(account_file()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

fn summary(m: &imap::types::Fetch) -> Option<MailSummary> {
    let env = m.envelope()?;
    let sender = env.from.as_ref().and_then(|v| v.first());
    let addr = sender
        .map(|a| format!("{}@{}", decode(a.mailbox), decode(a.host)))
        .unwrap_or_default();
    let name = sender.map(|a| decode(a.name)).filter(|n| !n.is_empty()).unwrap_or_else(|| addr.clone());
    Some(MailSummary {
        uid: m.uid?,
        from: name,
        from_addr: addr,
        subject: decode(env.subject),
        date: env.date.and_then(|d| mailparse::dateparse(&String::from_utf8_lossy(d)).ok()).map_or(0, |s| s * 1000),
        seen: m.flags().iter().any(|f| matches!(f, imap::types::Flag::Seen)),
    })
}

/// One page of the inbox, newest first: the newest `PAGE_SIZE` messages, or with `before` (a UID)
/// the `PAGE_SIZE` messages just older than it.
#[tauri::command]
pub async fn gmail_list(before: Option<u32>) -> Res<Vec<MailSummary>> {
    Ok(tokio::task::spawn_blocking(move || -> Result<Vec<MailSummary>> {
        let mut list = with_inbox(|s| {
            let fetched = match before {
                None => {
                    // re-EXAMINE: picks up mail that arrived since the last call
                    let exists = s.examine("INBOX")?.exists;
                    if exists == 0 {
                        return Ok(Vec::new());
                    }
                    let first = exists.saturating_sub(PAGE_SIZE - 1).max(1);
                    s.fetch(format!("{first}:{exists}"), "(UID FLAGS ENVELOPE)")?
                }
                Some(before) => {
                    if before <= 1 {
                        return Ok(Vec::new());
                    }
                    let mut uids: Vec<u32> = s.uid_search(format!("UID 1:{}", before - 1))?.into_iter().collect();
                    if uids.is_empty() {
                        return Ok(Vec::new());
                    }
                    uids.sort_unstable_by(|a, b| b.cmp(a));
                    uids.truncate(PAGE_SIZE as usize);
                    let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
                    s.uid_fetch(set, "(UID FLAGS ENVELOPE)")?
                }
            };
            Ok(fetched.iter().filter_map(summary).collect::<Vec<_>>())
        })?;
        list.sort_by(|a, b| b.uid.cmp(&a.uid));
        Ok(list)
    })
    .await??)
}

/// The whole message (RFC822). Read-only: EXAMINE keeps it unread in Gmail.
fn fetch_raw(uid: u32) -> Result<Vec<u8>> {
    with_inbox(|s| {
        let fetched = s.uid_fetch(uid.to_string(), "RFC822")?;
        fetched.iter().find_map(|m| m.body()).map(<[u8]>::to_vec).ok_or_else(|| anyhow!("không tìm thấy thư"))
    })
}

/// One message's content. Read-only: the inbox is opened with EXAMINE, so it stays unread in Gmail.
#[tauri::command]
pub async fn gmail_read(uid: u32) -> Res<MailBody> {
    Ok(tokio::task::spawn_blocking(move || -> Result<MailBody> {
        if let Some(cached) = lock(&BODIES).get(&uid) {
            return Ok(cached.clone());
        }
        let raw = fetch_raw(uid)?;
        let mail = mailparse::parse_mail(&raw)?;
        let (mut html, mut text, mut attachments) = (None, None, Vec::new());
        walk(&mail, &mut html, &mut text, &mut attachments);
        let body = MailBody {
            uid,
            from: header(&mail.headers, "From"),
            to: header(&mail.headers, "To"),
            subject: header(&mail.headers, "Subject"),
            date: date_ms(&mail.headers),
            html,
            text,
            attachments,
        };
        lock(&BODIES).insert(uid, body.clone());
        Ok(body)
    })
    .await??)
}

#[derive(Serialize)]
pub struct MailContext {
    file: String,
    files: Vec<String>,
}

/// Writes each attachment of the message into `out`, collecting the saved paths.
fn save_attachments(part: &ParsedMail, out: &std::path::Path, files: &mut Vec<String>) {
    let disposition = part.get_content_disposition();
    if disposition.disposition == DispositionType::Attachment {
        let name = disposition.params.get("filename").or(part.ctype.params.get("name")).cloned().unwrap_or_else(|| format!("file-{}", files.len() + 1));
        let path = out.join(crate::zalo_tasks::safe_name(&name));
        if let Ok(bytes) = part.get_body_raw()
            && std::fs::write(&path, bytes).is_ok()
        {
            files.push(path.display().to_string());
        }
        return;
    }
    for p in &part.subparts {
        save_attachments(p, out, files);
    }
}

/// Everything a coding chat needs about one email (like a Zalo task's context): a Markdown file with
/// its headers and text, with its attachments (and its HTML when it has no plain text) saved next to it.
#[tauri::command]
pub async fn gmail_task_context(uid: u32) -> Res<MailContext> {
    Ok(tokio::task::spawn_blocking(move || -> Result<MailContext> {
        let raw = fetch_raw(uid)?;
        let mail = mailparse::parse_mail(&raw)?;
        let out = user_data().join("gmail").join("context").join(uid.to_string());
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out)?;
        let (mut html, mut text, mut names) = (None, None, Vec::new());
        walk(&mail, &mut html, &mut text, &mut names);
        let mut files = Vec::new();
        save_attachments(&mail, &out, &mut files);
        let body = match (text, html) {
            (Some(t), _) => t,
            (None, Some(h)) => {
                let path = out.join("mail.html");
                std::fs::write(&path, h)?;
                format!("(Thư chỉ có bản HTML, đọc file: {})", path.display())
            }
            (None, None) => "(thư không có nội dung)".into(),
        };
        let subject = header(&mail.headers, "Subject");
        let md = format!(
            "# Việc từ Gmail: {subject}\n\n**Hướng dẫn cho bạn (Claude):** Đây là một việc tôi nhận qua email. Hãy đọc kỹ thư bên dưới{fil}, rồi tìm hiểu code trong project hiện tại liên quan tới yêu cầu. Sau đó tóm tắt lại yêu cầu bằng tiếng Việt, nêu nguyên nhân / vị trí code liên quan và đề xuất cách xử lý. CHƯA sửa code cho tới khi tôi xác nhận.\n\n- Người gửi: {from}\n- Gửi tới: {to}\n- Thời gian: {date}\n- Tiêu đề: {subject}\n{lf}\n## Nội dung thư\n\n{body}\n",
            fil = if files.is_empty() { "" } else { " và mở các tệp đính kèm" },
            from = header(&mail.headers, "From"),
            to = header(&mail.headers, "To"),
            date = header(&mail.headers, "Date"),
            lf = if files.is_empty() { String::new() } else { format!("- Tệp đính kèm:\n{}\n", files.iter().map(|p| format!("  - {p}")).collect::<Vec<_>>().join("\n")) },
        );
        let file = out.join("context.md");
        std::fs::write(&file, md)?;
        Ok(MailContext { file: file.display().to_string(), files })
    })
    .await??)
}
