//! The Zalo Web HTTP API, ported from the parts of zca-js 2.3.0 VIBE CODE uses: cookie login
//! (`zalo.js` + `apis/login.js`), QR login (`apis/loginQR.js`), `utils.request` (cookies,
//! redirects) and the endpoints in `apis/*.js` — each method names the file it comes from.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use futures_util::future::join_all;
use parking_lot::Mutex;
use reqwest::{
    Method, Url,
    header::{LOCATION, SET_COOKIE},
    multipart::{Form, Part},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::{
    cookies::CookieJar,
    listen::{Msg, group_message},
    proto::{
        API_TYPE, API_VERSION, ParamsEncryptor, decode_aes, decrypt_resp, encode_aes, encode_aes_utf8_key, jnum, jstr, make_url,
        md5_hex, not_minus_one, now_ms, sign_key, truthy, zalo_uuid,
    },
};

/// An error Zalo answered with (`ZaloApiError`): its message, and `error_code` when it gave one.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ZaloError {
    pub message: String,
    pub code: Option<i64>,
}

fn zerr(message: impl Into<String>) -> anyhow::Error {
    ZaloError { message: message.into(), code: None }.into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadType {
    User,
    Group,
}

/// What zca-js keeps of a session (`Credentials`): enough to log in again without a QR scan.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Credentials {
    pub imei: String,
    /// tough-cookie JSON: an array of cookies, or `{cookies: [...]}`
    pub cookie: Value,
    pub user_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/* ---------------- HTTP: zca-js `request()` ---------------- */

/// `URLSearchParams` serialization (application/x-www-form-urlencoded).
fn form_encode(pairs: &[(String, String)]) -> String {
    let mut u = Url::parse("http://x/").expect("static URL");
    u.query_pairs_mut().extend_pairs(pairs);
    u.query().unwrap_or_default().to_owned()
}

pub enum Body {
    Empty,
    Form(Vec<(String, String)>),
    Multipart(Form),
}

pub struct Resp {
    pub status: reqwest::StatusCode,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(&self) -> Result<Value> {
        Ok(serde_json::from_slice(&self.body)?)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

pub struct Http {
    client: reqwest::Client,
    pub jar: Mutex<CookieJar>,
    pub user_agent: String,
}

fn headers(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

impl Http {
    pub fn new(user_agent: &str, jar: CookieJar) -> Result<Self> {
        // redirects are followed by hand, so every hop's Set-Cookie lands in the jar
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build()?;
        Ok(Self { client, jar: Mutex::new(jar), user_agent: user_agent.to_owned() })
    }

    /// `getDefaultHeaders`. (No Accept-Encoding: responses come back uncompressed.)
    fn default_headers(&self, url: &Url) -> Vec<(String, String)> {
        let origin = url.origin().ascii_serialization();
        let mut h = headers(&[
            ("Accept", "application/json, text/plain, */*"),
            ("Accept-Language", "en-US,en;q=0.9"),
            ("content-type", "application/x-www-form-urlencoded"),
            ("Origin", "https://chat.zalo.me"),
            ("Referer", "https://chat.zalo.me/"),
        ]);
        h.push(("User-Agent".into(), self.user_agent.clone()));
        let cookie = self.jar.lock().cookie_string(&origin);
        if !cookie.is_empty() {
            h.push(("Cookie".into(), cookie));
        }
        h
    }

    /// One request with the session's headers + cookies, storing the cookies it gets back and
    /// following redirects (as GETs, with fresh default headers, as zca-js does).
    pub async fn request(&self, url: &str, method: Method, extra: Vec<(String, String)>, body: Body) -> Result<Resp> {
        let mut url = Url::parse(url).with_context(|| format!("bad URL {url}"))?;
        let mut method = method;
        let mut extra = extra;
        let mut body = Some(body);
        for _ in 0..10 {
            let mut h = self.default_headers(&url);
            for (k, v) in extra.drain(..) {
                match h.iter_mut().find(|(hk, _)| hk.eq_ignore_ascii_case(&k)) {
                    Some(slot) => slot.1 = v,
                    None => h.push((k, v)),
                }
            }
            let multipart = matches!(body, Some(Body::Multipart(_)));
            let mut req = self.client.request(method.clone(), url.clone());
            for (k, v) in h {
                if multipart && k.eq_ignore_ascii_case("content-type") {
                    continue;
                }
                req = req.header(k, v);
            }
            req = match body.take() {
                Some(Body::Form(f)) => req.body(form_encode(&f)),
                Some(Body::Multipart(m)) => req.multipart(m),
                _ => req,
            };
            let resp = req.send().await?;
            {
                let mut jar = self.jar.lock();
                for v in resp.headers().get_all(SET_COOKIE) {
                    if let Ok(s) = v.to_str() {
                        jar.set_from_header(s, &url);
                    }
                }
            }
            if let Some(loc) = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()) {
                url = url.join(loc)?;
                method = Method::GET;
                continue;
            }
            let status = resp.status();
            let body = resp.bytes().await?.to_vec();
            return Ok(Resp { status, body });
        }
        bail!("too many redirects")
    }
}

/// `error_code != 0`, loosely (JS `!=`).
fn code_ok(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(Value::String(_)) => jnum(v) == 0.0,
        Some(Value::Bool(b)) => !b,
        _ => false,
    }
}

fn api_error(j: &Value) -> anyhow::Error {
    ZaloError {
        message: j.get("error_message").and_then(Value::as_str).unwrap_or_default().to_owned(),
        code: j.get("error_code").and_then(|c| c.as_i64().or_else(|| c.as_str().and_then(|s| s.parse().ok()))),
    }
    .into()
}

/* ---------------- login with saved cookies ---------------- */

/// A logged-in session: what zca-js keeps in its context + `API`.
pub struct Api {
    pub http: Http,
    pub imei: String,
    pub language: String,
    pub uid: String,
    secret_key: String,
    pub settings: Value,
    extra_ver: Value,
    service_map: Value,
    pub ws_urls: Vec<String>,
    /// uploads waiting for their `file_done` socket event (zca-js `ctx.uploadCallbacks`)
    uploads: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

/// `Zalo.login(credentials)`.
pub async fn login(creds: &Credentials) -> Result<Arc<Api>> {
    if creds.imei.is_empty() || !truthy(Some(&creds.cookie)) || creds.user_agent.is_empty() {
        return Err(zerr("Missing required params"));
    }
    let http = Http::new(&creds.user_agent, CookieJar::from_credentials(&creds.cookie))?;
    let language = creds.language.clone().filter(|l| !l.is_empty()).unwrap_or_else(|| "vi".into());
    let login_data = get_login_info(&http, &creds.imei, &language).await?;
    let server = get_server_info(&http, &creds.imei).await?;
    let info = login_data.as_ref().and_then(|d| d.get("data")).filter(|d| truthy(Some(d))).cloned();
    let Some(info) = info else { return Err(zerr("Đăng nhập thất bại")) };
    let secret_key = info.get("zpw_enk").and_then(Value::as_str).unwrap_or_default().to_owned();
    if secret_key.is_empty() {
        return Err(zerr("Khởi tạo ngữ cảnh thất bại."));
    }
    let settings = server.get("setttings").filter(|v| truthy(Some(v))).or_else(|| server.get("settings")).cloned().unwrap_or(Value::Null);
    Ok(Arc::new(Api {
        uid: jstr(info.get("uid")),
        imei: creds.imei.clone(),
        language,
        secret_key,
        settings,
        extra_ver: server.get("extra_ver").cloned().unwrap_or(Value::Null),
        ws_urls: info.get("zpw_ws").and_then(Value::as_array).map(|a| a.iter().filter_map(|u| u.as_str().map(str::to_owned)).collect()).unwrap_or_default(),
        service_map: info.get("zpw_service_map_v3").cloned().unwrap_or(Value::Null),
        http,
        uploads: Mutex::new(HashMap::new()),
    }))
}

/// `login()` in apis/login.js: the encrypted `getLoginInfo` call. `None` when it didn't decrypt to JSON.
async fn get_login_info(http: &Http, imei: &str, language: &str) -> Result<Option<Value>> {
    let data = json!({ "computer_name": "Web", "imei": imei, "language": language, "ts": now_ms() }).to_string();
    let enc = ParamsEncryptor::new(API_TYPE, imei, now_ms() as u64)?;
    let encoded = encode_aes_utf8_key(&enc.encrypt_key, &data, false, false)?;
    let mut params: Vec<(&str, String)> = vec![
        ("zcid", enc.zcid.clone()),
        ("zcid_ext", enc.zcid_ext.clone()),
        ("enc_ver", ParamsEncryptor::ENC_VER.into()),
        ("params", encoded),
        ("type", API_TYPE.to_string()),
        ("client_version", API_VERSION.to_string()),
    ];
    let signkey = sign_key("getlogininfo", &params);
    params.push(("signkey", signkey));
    params.push(("nretry", "0".into()));
    let url = make_url("https://wpa.chat.zalo.me/api/login/getLoginInfo", &params, true)?;
    let r = http.request(&url, Method::GET, vec![], Body::Empty).await?;
    if !r.status.is_success() {
        bail!("Failed to fetch login info: {}", r.status.canonical_reason().unwrap_or_default());
    }
    let j = r.json()?;
    let Some(data) = j.get("data").and_then(Value::as_str) else { return Ok(None) };
    Ok(decrypt_resp(&enc.encrypt_key, data).ok().filter(|v| !v.is_string() && !v.is_null()))
}

async fn get_server_info(http: &Http, imei: &str) -> Result<Value> {
    let base = [("imei", imei.to_owned()), ("type", API_TYPE.to_string()), ("client_version", API_VERSION.to_string()), ("computer_name", "Web".into())];
    let mut params = base.to_vec();
    params.push(("signkey", sign_key("getserverinfo", &base)));
    let url = make_url("https://wpa.chat.zalo.me/api/login/getServerInfo", &params, false)?;
    let r = http.request(&url, Method::GET, vec![], Body::Empty).await?;
    if !r.status.is_success() {
        bail!("Failed to fetch server info: {}", r.status.canonical_reason().unwrap_or_default());
    }
    let j = r.json()?;
    match j.get("data") {
        Some(d) if !d.is_null() => Ok(d.clone()),
        _ => bail!("Failed to fetch server info: {}", jstr(j.get("error_message"))),
    }
}

/* ---------------- QR login ---------------- */

/// The user agent zca-js logs in with when none is given.
pub const QR_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

pub enum QrEvent {
    /// base64 PNG (no data: prefix)
    Generated { image: String },
    Expired,
    Scanned { display_name: String },
    Declined,
    /// the session to save, before the cookie login that follows
    GotLoginInfo(Credentials),
}

/// The error a QR login ends with when it expired, was declined or cancelled.
pub const QR_ABORTED: &str = "Operation aborted";

const SEC_CH_UA: &str = r#""Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99""#;

fn id_headers(referer: &str, document: bool) -> Vec<(String, String)> {
    let mut h = if document {
        headers(&[
            ("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"),
            ("priority", "u=0, i"),
            ("sec-fetch-dest", "document"),
            ("sec-fetch-mode", "navigate"),
            ("upgrade-insecure-requests", "1"),
        ])
    } else {
        headers(&[
            ("accept", "*/*"),
            ("content-type", "application/x-www-form-urlencoded"),
            ("priority", "u=1, i"),
            ("sec-fetch-dest", "empty"),
            ("sec-fetch-mode", "cors"),
        ])
    };
    h.extend(headers(&[
        ("accept-language", "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5"),
        ("sec-ch-ua", SEC_CH_UA),
        ("sec-ch-ua-mobile", "?0"),
        ("sec-ch-ua-platform", "\"Windows\""),
        ("Referer", referer),
        ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ]));
    h
}

const REF_PC: &str = "https://id.zalo.me/account?continue=https%3A%2F%2Fzalo.me%2Fpc";
const REF_CHAT: &str = "https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F";

fn form(pairs: &[(&str, &str)]) -> Body {
    Body::Form(pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect())
}

async fn id_post(http: &Http, url: &str, referer: &str, pairs: &[(&str, &str)]) -> Result<Value> {
    let mut h = id_headers(referer, false);
    h.push(("sec-fetch-site".into(), "same-origin".into()));
    http.request(url, Method::POST, h, form(pairs)).await?.json()
}

/// `apiloginQR` + the cookie login after it. `on` hears each step; expiry (100 s) and a decline
/// on the phone end the login with [`QR_ABORTED`] right after their event.
pub async fn login_qr(on: impl Fn(QrEvent) + Send + Sync) -> Result<Arc<Api>> {
    let http = Http::new(QR_USER_AGENT, CookieJar::default())?;

    // loadLoginPage: the login script's version
    let mut h = id_headers("https://chat.zalo.me/", true);
    h.push(("cache-control".into(), "max-age=0".into()));
    h.push(("sec-fetch-site".into(), "same-site".into()));
    h.push(("sec-fetch-user".into(), "?1".into()));
    let html = http.request("https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F", Method::GET, h, Body::Empty).await?.text();
    let version = regex::Regex::new(r"https://stc-zlogin\.zdn\.vn/main-([\d.]+)\.js")?
        .captures(&html)
        .map(|c| c[1].to_owned())
        .ok_or_else(|| zerr("Cannot get API login version"))?;

    let _ = id_post(&http, "https://id.zalo.me/account/logininfo", REF_PC, &[("continue", "https://zalo.me/pc"), ("v", &version)]).await;
    let _ = id_post(&http, "https://id.zalo.me/account/verify-client", REF_PC, &[("type", "device"), ("continue", "https://zalo.me/pc"), ("v", &version)]).await;
    let generated = id_post(&http, "https://id.zalo.me/account/authen/qr/generate", REF_PC, &[("continue", "https://zalo.me/pc"), ("v", &version)]).await.ok();
    let Some(data) = generated.as_ref().and_then(|g| g.get("data")).filter(|d| truthy(Some(d))) else {
        return Err(zerr(format!("Unable to generate QRCode\nResponse: {}", generated.map(|g| g.to_string()).unwrap_or_else(|| "undefined".into()))));
    };
    let code = jstr(data.get("code"));
    let image = data.get("image").and_then(Value::as_str).unwrap_or_default();
    on(QrEvent::Generated { image: image.strip_prefix("data:image/png;base64,").unwrap_or(image).to_owned() });

    let waiting = async {
        let scan = long_poll(&http, "https://id.zalo.me/account/authen/qr/waiting-scan", &[("code", &code), ("continue", "https://chat.zalo.me/"), ("v", &version)])
            .await
            .ok()
            .filter(|s| truthy(s.get("data")))
            .ok_or_else(|| zerr("Cannot get scan result"))?;
        on(QrEvent::Scanned { display_name: scan["data"].get("display_name").and_then(Value::as_str).unwrap_or_default().to_owned() });
        long_poll(
            &http,
            "https://id.zalo.me/account/authen/qr/waiting-confirm",
            &[("code", &code), ("gToken", ""), ("gAction", "CONFIRM_QR"), ("continue", "https://chat.zalo.me/"), ("v", &version)],
        )
        .await
        .map_err(|_| zerr("Cannot get confirm result"))
    };
    let confirm = tokio::select! {
        r = waiting => r?,
        _ = tokio::time::sleep(Duration::from_secs(100)) => {
            on(QrEvent::Expired);
            return Err(zerr(QR_ABORTED));
        }
    };
    match confirm.get("error_code").and_then(Value::as_i64) {
        Some(-13) => {
            on(QrEvent::Declined);
            return Err(zerr(QR_ABORTED));
        }
        _ if !code_ok(confirm.get("error_code")) => {
            return Err(zerr(format!("An error has occurred.\nResponse: {}", serde_json::to_string_pretty(&confirm).unwrap_or_default())));
        }
        _ => {}
    }

    // checkSession: its redirects set the chat cookies
    let mut h = id_headers(REF_CHAT, true);
    h.push(("sec-fetch-site".into(), "same-origin".into()));
    http.request("https://id.zalo.me/account/checksession?continue=https%3A%2F%2Fchat.zalo.me%2Findex.html", Method::GET, h, Body::Empty)
        .await
        .map_err(|_| zerr("Cannot get session, login failed"))?;
    let mut h = id_headers("https://chat.zalo.me/", false);
    h.retain(|(k, _)| k != "content-type");
    h.push(("sec-fetch-site".into(), "same-site".into()));
    let user = http.request("https://jr.chat.zalo.me/jr/userinfo", Method::GET, h, Body::Empty).await.and_then(|r| r.json()).ok();
    let Some(user) = user.as_ref().and_then(|u| u.get("data")).filter(|d| truthy(Some(d))) else {
        return Err(zerr("Can't get account info"));
    };
    if !truthy(user.get("logged")) {
        return Err(zerr("Can't login"));
    }

    let creds = Credentials { imei: zalo_uuid(QR_USER_AGENT), cookie: http.jar.lock().to_json(), user_agent: QR_USER_AGENT.into(), language: None };
    on(QrEvent::GotLoginInfo(creds.clone()));
    login(&Credentials { language: Some("vi".into()), ..creds }).await
}

/// `waitingScan` / `waitingConfirm`: Zalo answers error 8 while nothing happened yet.
async fn long_poll(http: &Http, url: &str, pairs: &[(&str, &str)]) -> Result<Value> {
    loop {
        let r = id_post(http, url, REF_CHAT, pairs).await?;
        if r.get("error_code").and_then(Value::as_i64) != Some(8) {
            return Ok(r);
        }
    }
}

/* ---------------- the API ---------------- */

/// `addReaction`'s icon → rType table (source is always 6).
fn reaction_type(icon: &str) -> i64 {
    match icon {
        ":>" => 0,
        "/-strong" => 3,
        "/-heart" => 5,
        ":o" => 32,
        ":-((" => 2,
        ":-h" => 20,
        ":-*" => 8,
        ":')" => 7,
        "/-shit" => 66,
        "/-rose" => 120,
        "/-break" => 65,
        "/-weak" => 4,
        ";xx" => 29,
        ";-/" => 51,
        ";-)" => 45,
        "/-fade" => 121,
        "/-li" => 67,
        "/-bd" => 126,
        "/-bome" => 127,
        "/-ok" => 68,
        "/-v" => 69,
        "/-thanks" => 70,
        "/-punch" => 71,
        "/-share" => 72,
        "_()_" => 73,
        "/-no" => 131,
        "/-bad" => 132,
        "/-loveu" => 133,
        "--b" => 1,
        ":((" => 16,
        "x-)" => 21,
        "8-)" => 22,
        ";-d" => 23,
        "b-)" => 26,
        ":--|" => 30,
        "p-(" => 35,
        ":-bye" => 36,
        "|-)" => 38,
        ":wipe" => 39,
        ":-dig" => 42,
        "&-(" => 44,
        ":handclap" => 46,
        ">-|" => 47,
        ":-f" => 48,
        ":-l" => 49,
        ":-r" => 50,
        ";-x" => 52,
        ":-o" => 53,
        ";-s" => 54,
        ";-a" => 60,
        ":-<" => 61,
        ":))" => 62,
        "$-)" => 63,
        "/-beer" => 99,
        _ => -1,
    }
}

/// JS `parseInt(s)` written back as JSON, as `JSON.stringify` would (ids past 2^53 lose digits
/// exactly like they do in Zalo Web).
fn js_parse_int_json(s: &str) -> String {
    let t = s.trim_start();
    let (neg, digits) = match t.strip_prefix('-') {
        Some(d) => (true, d),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return "null".into();
    }
    let n: f64 = digits.parse().unwrap_or(f64::NAN);
    let n = if neg { -n } else { n };
    if n.abs() >= 1e21 { format!("{n:e}").replace("e", "e+") } else { format!("{n}") }
}

/// A message to send (`sendMessage`'s `MessageContent`).
#[derive(Default)]
pub struct Outgoing {
    pub msg: String,
    pub quote: Option<Quote>,
    pub mentions: Vec<Mention>,
    pub attachments: Vec<PathBuf>,
    pub ttl: i64,
}

/// `SendMessageQuote`: the replied-to message as Zalo sent it.
#[derive(Clone)]
pub struct Quote {
    pub content: Value,
    pub msg_type: String,
    pub property_ext: Option<Value>,
    pub uid_from: String,
    pub msg_id: String,
    pub cli_msg_id: String,
    pub ts: String,
    pub ttl: Option<Value>,
}

#[derive(Clone)]
pub struct Mention {
    pub pos: i64,
    pub uid: String,
    pub len: i64,
}

#[derive(Debug, Default)]
pub struct SendResult {
    pub message: Option<Value>,
    pub attachment: Vec<Value>,
}

/// What `sendSeenEvent` needs of one message.
pub struct SeenMsg {
    pub msg_id: String,
    pub cli_msg_id: String,
    pub uid_from: String,
    pub id_to: String,
    pub msg_type: String,
    pub st: Option<Value>,
    pub at: Option<Value>,
    pub cmd: Option<Value>,
}

/// One request `sendMessage` makes.
struct SendReq {
    url: String,
    body: Body,
}

fn file_ext(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(pairs.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.to_owned(), v)).collect::<Map<_, _>>())
}

/// `toid` for a person, `grid` for a group.
fn dest(kind: ThreadType, thread_id: &str) -> (&'static str, Value) {
    (if kind == ThreadType::Group { "grid" } else { "toid" }, json!(thread_id))
}

impl Api {
    /// The first URL of a service in `zpw_service_map_v3`.
    fn svc(&self, name: &str) -> Result<String> {
        let v = &self.service_map[name];
        v.as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .or_else(|| v.as_str())
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("Zalo did not give a `{name}` service"))
    }

    fn url(&self, base: &str, params: &[(&str, String)]) -> Result<String> {
        make_url(base, params, true)
    }

    fn enc(&self, params: &Value) -> Result<String> {
        encode_aes(&self.secret_key, &params.to_string()).map_err(|_| zerr("Failed to encrypt params"))
    }

    fn sharefile(&self, key: &str) -> &Value {
        &self.settings["features"]["sharefile"][key]
    }

    /// `resolveResponse` / `handleZaloResponse`: unwrap (and decrypt) `data`.
    pub fn resolve(&self, r: &Resp, encrypted: bool) -> Result<Value> {
        if !r.status.is_success() {
            return Err(zerr(format!("Request failed with status code {}", r.status.as_u16())));
        }
        let j: Value = serde_json::from_slice(&r.body).map_err(|_| zerr("Failed to parse response data"))?;
        if !code_ok(j.get("error_code")) {
            return Err(api_error(&j));
        }
        let decoded: Value = if encrypted {
            let data = j.get("data").and_then(Value::as_str).ok_or_else(|| zerr("Failed to parse response data"))?;
            decode_aes(&self.secret_key, data).ok().and_then(|s| serde_json::from_str(&s).ok()).ok_or_else(|| zerr("Failed to parse response data"))?
        } else {
            j
        };
        if !code_ok(decoded.get("error_code")) {
            return Err(api_error(&decoded));
        }
        Ok(decoded.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn get(&self, url: &str) -> Result<Value> {
        let r = self.http.request(url, Method::GET, vec![], Body::Empty).await?;
        self.resolve(&r, true)
    }

    /// GET with `params` (encrypted) added to the URL.
    async fn get_with(&self, base: &str, params: &Value) -> Result<Value> {
        let url = self.url(base, &[("params", self.enc(params)?)])?;
        self.get(&url).await
    }

    /// POST `params=<encrypted>` as a form.
    async fn post_with(&self, url: &str, params: &Value) -> Result<Value> {
        let body = Body::Form(vec![("params".into(), self.enc(params)?)]);
        let r = self.http.request(url, Method::POST, vec![], body).await?;
        self.resolve(&r, true)
    }

    /// The socket said an upload finished (`file_done`).
    pub fn upload_done(&self, file_id: &str, data: Value) {
        if let Some(tx) = self.uploads.lock().remove(file_id) {
            let _ = tx.send(data);
        }
    }

    /* ----- profile, friends, groups ----- */

    /// fetchAccountInfo.js
    pub async fn fetch_account_info(&self) -> Result<Value> {
        self.get(&self.url(&format!("{}/api/social/profile/me-v2", self.svc("profile")?), &[])?).await
    }

    /// getAllFriends.js
    pub async fn get_all_friends(&self) -> Result<Vec<Value>> {
        let base = self.url(&format!("{}/api/social/friend/getfriends", self.svc("profile")?), &[])?;
        let params = json!({ "incInvalid": 1, "page": 1, "count": 20000, "avatar_size": 120, "actiontime": 0, "imei": self.imei });
        Ok(self.get_with(&base, &params).await?.as_array().cloned().unwrap_or_default())
    }

    /// getAllGroups.js
    pub async fn get_all_groups(&self) -> Result<Value> {
        self.get(&self.url(&format!("{}/api/group/getlg/v4", self.svc("group_poll")?), &[])?).await
    }

    /// getGroupInfo.js
    pub async fn get_group_info(&self, ids: &[String]) -> Result<Value> {
        let url = self.url(&format!("{}/api/group/getmg-v2", self.svc("group")?), &[])?;
        let map = format!("{{{}}}", ids.iter().map(|id| format!("{}:0", Value::String(id.clone()))).collect::<Vec<_>>().join(","));
        self.post_with(&url, &json!({ "gridVerMap": map })).await
    }

    /// getUserInfo.js
    pub async fn get_user_info(&self, ids: &[String]) -> Result<Value> {
        if ids.is_empty() {
            return Err(zerr("Missing user id"));
        }
        let url = self.url(&format!("{}/api/social/friend/getprofiles/v2", self.svc("profile")?), &[])?;
        let ids: Vec<String> = ids.iter().map(|id| if id.contains('_') { id.clone() } else { format!("{id}_0") }).collect();
        let params = json!({
            "phonebook_version": self.extra_ver.get("phonebook").cloned().unwrap_or(Value::Null),
            "friend_pversion_map": ids,
            "avatar_size": 120,
            "language": self.language,
            "show_online_status": 1,
            "imei": self.imei,
        });
        self.post_with(&url, &params).await
    }

    /// getPinConversations.js
    pub async fn get_pin_conversations(&self) -> Result<Value> {
        let base = self.url(&format!("{}/api/pinconvers/list", self.svc("conversation")?), &[])?;
        self.get_with(&base, &json!({ "imei": self.imei })).await
    }

    /// lastOnline.js
    pub async fn last_online(&self, uid: &str) -> Result<Value> {
        let base = self.url(&format!("{}/api/social/profile/lastOnline", self.svc("profile")?), &[])?;
        self.get_with(&base, &json!({ "uid": uid, "conv_type": 1, "imei": self.imei })).await
    }

    /// findUser.js (the phone goes international for Vietnamese accounts).
    pub async fn find_user(&self, phone: &str) -> Result<Value> {
        if phone.is_empty() {
            return Err(zerr("Missing phoneNumber"));
        }
        let phone = match phone.strip_prefix('0') {
            Some(rest) if self.language == "vi" => format!("84{rest}"),
            _ => phone.to_owned(),
        };
        let params = self.enc(&json!({ "phone": phone, "avatar_size": 240, "language": self.language, "imei": self.imei, "reqSrc": 40 }))?;
        let base = self.url(&format!("{}/api/friend/profile/get", self.svc("friend")?), &[])?;
        // zca-js puts `params` on the URL twice
        let once = make_url(&base, &[("params", params.clone())], false)?;
        self.get(&self.url(&once, &[("params", params)])?).await
    }

    /// getCloudMessage.js: one page (≤ 50) of a group's history. Returns the page and its messages.
    pub async fn get_cloud_message(&self, group_id: &str, last_msg_id: Option<&str>, is_old: bool) -> Result<(Value, Vec<Msg>)> {
        if group_id.is_empty() {
            return Err(zerr("Missing groupId"));
        }
        let group_id = group_id.strip_prefix('g').unwrap_or(group_id);
        let svc = self.svc("group_cloud_message")?;
        let base = self.url(&format!("{svc}/api/cm/{}", if is_old { "getoldv2" } else { "getrecentv2" }), &[])?;
        let last = last_msg_id.filter(|s| !s.is_empty());
        let params = json!({
            "groupId": group_id,
            "globalMsgId": last.unwrap_or("0"),
            "count": 50,
            "msgIds": [],
            "imei": self.imei,
            "src": if last.is_some() { 3 } else { 1 },
        });
        let url = self.url(&base, &[("params", self.enc(&params)?), ("nretry", "0".into())])?;
        let mut data = self.get(&url).await?;
        if let Some(s) = data.as_str() {
            data = serde_json::from_str(s)?;
        }
        let msgs = data.get("groupMsgs").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|m| group_message(&self.uid, m)).collect();
        Ok((data, msgs))
    }

    /* ----- stickers ----- */

    /// getStickers.js: sticker ids for a keyword.
    pub async fn get_stickers(&self, keyword: &str) -> Result<Vec<i64>> {
        if keyword.is_empty() {
            return Err(zerr("Missing keyword"));
        }
        let mut url = Url::parse(&self.url(&format!("{}/api/message/sticker", self.svc("sticker")?), &[])?)?;
        url.set_path(&format!("{}/suggest/stickers", url.path()));
        let data = self.get_with(url.as_str(), &json!({ "keyword": keyword, "gif": 1, "guggy": 0, "imei": self.imei })).await?;
        Ok(data["sugg_sticker"].as_array().into_iter().flatten().filter_map(|s| s.get("sticker_id").and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))).collect())
    }

    /// getStickersDetail.js: details of each id (the ones that fail are left out).
    pub async fn get_stickers_detail(&self, ids: &[i64]) -> Result<Vec<Value>> {
        if ids.is_empty() {
            return Err(zerr("Missing sticker id"));
        }
        let base = self.url(&format!("{}/api/message/sticker/sticker_detail", self.svc("sticker")?), &[])?;
        let all = join_all(ids.iter().map(|id| {
            let base = &base;
            async move { self.get_with(base, &json!({ "sid": id })).await }
        })).await;
        Ok(all.into_iter().filter_map(Result::ok).collect())
    }

    /// sendSticker.js
    pub async fn send_sticker(&self, id: i64, cate_id: i64, sticker_type: i64, thread_id: &str, kind: ThreadType) -> Result<Value> {
        if thread_id.is_empty() {
            return Err(zerr("Missing threadId"));
        }
        if id == 0 {
            return Err(zerr("Missing sticker id"));
        }
        if sticker_type == 0 {
            return Err(zerr("Missing sticker type"));
        }
        let url = match kind {
            ThreadType::User => self.url(&format!("{}/api/message/sticker", self.svc("chat")?), &[("nretry", "0".into())])?,
            ThreadType::Group => self.url(&format!("{}/api/group/sticker", self.svc("group")?), &[("nretry", "0".into())])?,
        };
        let (k, v) = dest(kind, thread_id);
        let params = obj(vec![
            ("stickerId", json!(id)),
            ("cateId", json!(cate_id)),
            ("type", json!(sticker_type)),
            ("clientId", json!(now_ms())),
            ("imei", json!(self.imei)),
            ("zsource", json!(101)),
            (k, v),
        ]);
        self.post_with(&url, &params).await
    }

    /* ----- message actions ----- */

    /// addReaction.js (`icon` is a Zalo reaction code, "" removes mine).
    pub async fn add_reaction(&self, icon: &str, msg_id: &str, cli_msg_id: &str, thread_id: &str, kind: ThreadType) -> Result<Value> {
        let svc = self.svc("reaction")?;
        let url = self.url(&format!("{svc}/api/{}/reaction", if kind == ThreadType::Group { "group" } else { "message" }), &[])?;
        let message = format!(
            r#"{{"rMsg":[{{"gMsgID":{},"cMsgID":{},"msgType":1}}],"rIcon":{},"rType":{},"source":6}}"#,
            js_parse_int_json(msg_id),
            js_parse_int_json(cli_msg_id),
            Value::String(icon.to_owned()),
            reaction_type(icon)
        );
        let mut params = json!({ "react_list": [{ "message": message, "clientId": now_ms() }] });
        match kind {
            ThreadType::User => params["toid"] = json!(thread_id),
            ThreadType::Group => {
                params["grid"] = json!(thread_id);
                params["imei"] = json!(self.imei);
            }
        }
        let mut data = self.post_with(&url, &params).await?;
        if let Some(s) = data.get("msgIds").and_then(Value::as_str) {
            data = json!({ "msgIds": serde_json::from_str::<Value>(s).unwrap_or(Value::Null) });
        }
        Ok(data)
    }

    /// undo.js: recall my message for everyone.
    pub async fn undo(&self, msg_id: &str, cli_msg_id: &str, thread_id: &str, kind: ThreadType) -> Result<Value> {
        let url = match kind {
            ThreadType::User => self.url(&format!("{}/api/message/undo", self.svc("chat")?), &[])?,
            ThreadType::Group => self.url(&format!("{}/api/group/undomsg", self.svc("group")?), &[])?,
        };
        let mut params = json!({ "msgId": msg_id, "clientId": now_ms(), "cliMsgIdUndo": cli_msg_id });
        match kind {
            ThreadType::Group => {
                params["grid"] = json!(thread_id);
                params["visibility"] = json!(0);
                params["imei"] = json!(self.imei);
            }
            ThreadType::User => params["toid"] = json!(thread_id),
        }
        self.post_with(&url, &params).await
    }

    /// deleteMessage.js
    pub async fn delete_message(&self, thread_id: &str, kind: ThreadType, msg_id: &str, cli_msg_id: &str, uid_from: &str, only_me: bool) -> Result<Value> {
        let group = kind == ThreadType::Group;
        if self.uid == uid_from && !only_me {
            return Err(zerr("To delete your message for everyone, use undo api instead"));
        }
        if !group && !only_me {
            return Err(zerr("Can't delete message for everyone in a private chat"));
        }
        let url = match kind {
            ThreadType::User => self.url(&format!("{}/api/message/delete", self.svc("chat")?), &[])?,
            ThreadType::Group => self.url(&format!("{}/api/group/deletemsg", self.svc("group")?), &[])?,
        };
        let (k, v) = dest(kind, thread_id);
        let mut params = obj(vec![
            (k, v),
            ("cliMsgId", json!(now_ms())),
            ("msgs", json!([{ "cliMsgId": cli_msg_id, "globalMsgId": msg_id, "ownerId": uid_from, "destId": thread_id }])),
            ("onlyMe", json!(if only_me { 1 } else { 0 })),
        ]);
        if !group {
            params["imei"] = json!(self.imei);
        }
        self.post_with(&url, &params).await
    }

    /// forwardMessage.js (text only, no reference).
    pub async fn forward_message(&self, message: &str, thread_ids: &[String], kind: ThreadType) -> Result<Value> {
        if message.is_empty() {
            return Err(zerr("Missing message content"));
        }
        if thread_ids.is_empty() {
            return Err(zerr("Missing thread IDs"));
        }
        let svc = self.svc("file")?;
        let url = self.url(&format!("{svc}/api/{}/mforward", if kind == ThreadType::Group { "group" } else { "message" }), &[])?;
        let client_id = now_ms().to_string();
        let msg_info = json!({ "message": message }).to_string();
        let params = match kind {
            ThreadType::User => json!({
                "toIds": thread_ids.iter().map(|t| json!({ "clientId": client_id, "toUid": t, "ttl": 0 })).collect::<Vec<_>>(),
                "imei": self.imei,
                "ttl": 0,
                "msgType": "1",
                "totalIds": thread_ids.len(),
                "msgInfo": msg_info,
                "decorLog": "null",
            }),
            ThreadType::Group => json!({
                "grids": thread_ids.iter().map(|t| json!({ "clientId": client_id, "grid": t, "ttl": 0 })).collect::<Vec<_>>(),
                "ttl": 0,
                "msgType": "1",
                "totalIds": thread_ids.len(),
                "msgInfo": msg_info,
                "decorLog": "null",
            }),
        };
        self.post_with(&url, &params).await
    }

    /// sendSeenEvent.js: 1–50 messages of one conversation.
    pub async fn send_seen_event(&self, msgs: &[SeenMsg], kind: ThreadType) -> Result<Value> {
        if msgs.is_empty() || msgs.len() > 50 {
            return Err(zerr("messages must contain between 1 and 50 messages."));
        }
        let group = kind == ThreadType::Group;
        let thread_of = |m: &SeenMsg| if group { m.id_to.clone() } else { m.uid_from.clone() };
        let thread_id = thread_of(&msgs[0]);
        // zca-js sends 0 for any number it has and -1 for what is missing
        let flag = |v: &Option<Value>| if v.as_ref().is_some_and(|v| v.is_number() || truthy(Some(v))) { 0 } else { -1 };
        let mut data = Vec::new();
        for m in msgs {
            if thread_of(m) != thread_id {
                return Err(zerr("All messages must belong to the same thread."));
            }
            data.push(json!({
                "cmi": m.cli_msg_id,
                "gmi": m.msg_id,
                "si": m.uid_from,
                "di": if m.id_to == self.uid { "0".to_owned() } else { m.id_to.clone() },
                "mt": m.msg_type,
                "st": flag(&m.st),
                "at": flag(&m.at),
                "cmd": flag(&m.cmd),
                // zca-js: `parseInt(ts) || 0 === parseInt(ts) ? 0 : -1`, so always 0 for a number
                "ts": 0,
            }));
        }
        let mut infos = json!({ "data": data });
        infos[if group { "grid" } else { "senderId" }] = json!(thread_id);
        let mut params = json!({ "msgInfos": infos.to_string() });
        if group {
            params["imei"] = json!(self.imei);
        }
        let url = match kind {
            ThreadType::User => self.url(&format!("{}/api/message/seenv2", self.svc("chat")?), &[("nretry", "0".into())])?,
            ThreadType::Group => self.url(&format!("{}/api/group/seenv2", self.svc("group")?), &[("nretry", "0".into())])?,
        };
        self.post_with(&url, &params).await
    }

    /// sendTypingEvent.js
    pub async fn send_typing_event(&self, thread_id: &str, kind: ThreadType) -> Result<Value> {
        if thread_id.is_empty() {
            return Err(zerr("Missing threadId"));
        }
        let (k, v) = dest(kind, thread_id);
        let mut params = obj(vec![(k, v), ("imei", json!(self.imei))]);
        let url = match kind {
            ThreadType::User => {
                params["destType"] = json!(3);
                self.url(&format!("{}/api/message/typing", self.svc("chat")?), &[])?
            }
            ThreadType::Group => self.url(&format!("{}/api/group/typing", self.svc("group")?), &[])?,
        };
        self.post_with(&url, &params).await
    }

    /* ----- sending: sendMessage.js + uploadAttachment.js ----- */

    fn max_file(&self) -> f64 {
        self.sharefile("max_file").as_f64().unwrap_or(f64::INFINITY)
    }

    fn exceeds_max_size(&self, size: u64) -> bool {
        self.sharefile("max_size_share_file_v3").as_f64().is_some_and(|mb| size as f64 > mb * 1024.0 * 1024.0)
    }

    fn max_size_mb(&self) -> String {
        jstr(Some(self.sharefile("max_size_share_file_v3")))
    }

    /// `handleMentions` (only groups have mentions).
    fn mentions(&self, kind: ThreadType, msg: &str, mentions: &[Mention]) -> Result<Vec<Value>> {
        if kind != ThreadType::Group {
            return Ok(vec![]);
        }
        let mut total = 0;
        let list: Vec<Value> = mentions
            .iter()
            .filter(|m| m.pos >= 0 && !m.uid.is_empty() && m.len > 0)
            .map(|m| {
                total += m.len;
                json!({ "pos": m.pos, "uid": m.uid, "len": m.len, "type": if m.uid == "-1" { 1 } else { 0 } })
            })
            .collect();
        if total > msg.encode_utf16().count() as i64 {
            return Err(zerr("Invalid mentions: total mention characters exceed message length"));
        }
        Ok(list)
    }

    /// `handleMessage`: a text (or quote) message.
    fn text_request(&self, m: &Outgoing, thread_id: &str, kind: ThreadType) -> Result<SendReq> {
        if m.msg.is_empty() {
            return Err(zerr("Missing message content"));
        }
        let group = kind == ThreadType::Group;
        let mentions = self.mentions(kind, &m.msg, &m.mentions)?;
        if let Some(q) = &m.quote {
            if !q.content.is_string() && q.msg_type == "webchat" {
                return Err(zerr("This kind of `webchat` quote type is not available"));
            }
            if q.msg_type == "group.poll" {
                return Err(zerr("The `group.poll` quote type is not available"));
            }
        }
        let mention_info = (!mentions.is_empty() && group).then(|| json!(Value::Array(mentions).to_string()));
        let mention_info = mention_info.unwrap_or(Value::Null);
        let some_if = |cond: bool, v: Value| if cond { v } else { Value::Null };
        let params = match &m.quote {
            Some(q) => obj(vec![
                ("toid", some_if(!group, json!(thread_id))),
                ("grid", some_if(group, json!(thread_id))),
                ("message", json!(m.msg)),
                ("clientId", json!(now_ms())),
                ("mentionInfo", mention_info.clone()),
                ("qmsgOwner", json!(q.uid_from)),
                ("qmsgId", json!(q.msg_id)),
                ("qmsgCliId", json!(q.cli_msg_id)),
                ("qmsgType", json!(client_message_type(&q.msg_type))),
                ("qmsgTs", json!(q.ts)),
                ("qmsg", match &q.content {
                    Value::String(s) => json!(s),
                    _ => prepare_qmsg(q),
                }),
                ("imei", some_if(!group, json!(self.imei))),
                ("visibility", some_if(group, json!(0))),
                ("qmsgAttach", if group { prepare_qmsg_attach(q).map(|a| json!(a.to_string())).unwrap_or(Value::Null) } else { Value::Null }),
                ("qmsgTTL", q.ttl.clone().unwrap_or(Value::Null)),
                ("ttl", json!(m.ttl)),
            ]),
            None => obj(vec![
                ("message", json!(m.msg)),
                ("clientId", json!(now_ms())),
                ("mentionInfo", mention_info.clone()),
                ("imei", some_if(!group, json!(self.imei))),
                ("ttl", json!(m.ttl)),
                ("visibility", some_if(group, json!(0))),
                ("toid", some_if(!group, json!(thread_id))),
                ("grid", some_if(group, json!(thread_id))),
            ]),
        };
        let base = match kind {
            ThreadType::User => self.url(&format!("{}/api/message", self.svc("chat")?), &[("nretry", "0".into())])?,
            ThreadType::Group => self.url(&format!("{}/api/group", self.svc("group")?), &[("nretry", "0".into())])?,
        };
        let mut url = Url::parse(&base)?;
        let tail = if m.quote.is_some() {
            "quote"
        } else if group {
            if mention_info.is_null() { "sendmsg" } else { "mention" }
        } else {
            "sms"
        };
        url.set_path(&format!("{}/{tail}", url.path()));
        Ok(SendReq { url: url.to_string(), body: Body::Form(vec![("params".into(), self.enc(&params)?)]) })
    }

    /// `send`: the requests at once, each resolved.
    async fn send_all(&self, list: Vec<SendReq>) -> Result<Vec<Value>> {
        let all = join_all(list.into_iter().map(|s| async move {
            let r = self.http.request(&s.url, Method::POST, vec![], s.body).await?;
            self.resolve(&r, true)
        }))
        .await;
        all.into_iter().collect()
    }

    /// `sendMessage(message, threadId, type)`.
    pub async fn send_message(&self, m: Outgoing, thread_id: &str, kind: ThreadType) -> Result<SendResult> {
        if thread_id.is_empty() {
            return Err(zerr("Missing threadId"));
        }
        if m.msg.is_empty() && m.attachments.is_empty() {
            return Err(zerr("Missing message content"));
        }
        if m.attachments.len() as f64 > self.max_file() {
            return Err(zerr(format!("Exceed maximum file of {}", jstr(Some(self.sharefile("max_file"))))));
        }
        let mut res = SendResult::default();
        if !m.attachments.is_empty() {
            let first_ext = file_ext(&m.attachments[0]);
            let can_be_desc = m.attachments.len() == 1 && ["jpg", "jpeg", "png", "webp"].contains(&first_ext.as_str());
            let mut msg = m.msg.clone();
            let mut mentions = m.mentions.clone();
            if (!can_be_desc && !msg.is_empty()) || (!msg.is_empty() && m.quote.is_some()) {
                // text and files go separately
                let req = self.text_request(&m, thread_id, kind)?;
                res.message = self.send_all(vec![req]).await?.into_iter().next();
                msg.clear();
                mentions.clear();
            }
            let reqs = self.attachment_requests(&msg, &mentions, &m.attachments, m.quote.is_some(), m.ttl, thread_id, kind).await?;
            res.attachment = self.send_all(reqs).await?;
            return Ok(res);
        }
        let req = self.text_request(&m, thread_id, kind)?;
        res.message = self.send_all(vec![req]).await?.into_iter().next();
        Ok(res)
    }

    /// `handleAttachment`: upload the files, then one send request per file.
    #[allow(clippy::too_many_arguments)]
    async fn attachment_requests(&self, msg: &str, mentions: &[Mention], files: &[PathBuf], quoted: bool, ttl: i64, thread_id: &str, kind: ThreadType) -> Result<Vec<SendReq>> {
        let group = kind == ThreadType::Group;
        let first_ext = file_ext(&files[0]);
        let can_be_desc = files.len() == 1 && ["jpg", "jpeg", "png", "webp"].contains(&first_ext.as_str());
        let (gifs, others): (Vec<&PathBuf>, Vec<&PathBuf>) = files.iter().partition(|p| file_ext(p) == "gif");
        let uploaded = if others.is_empty() { vec![] } else { self.upload_attachment(&others, thread_id, kind).await? };
        let mention_list = self.mentions(kind, msg, mentions)?;
        let mentions_ok = !mention_list.is_empty() && group && others.len() == 1;
        let multi = others.len() > 1;
        let layout_id = now_ms().to_string();
        let mut client_id = now_ms();
        let mut index = 0;
        let some_if = |cond: bool, v: Value| if cond { v } else { Value::Null };
        let svc = self.svc("file")?;
        let attach_base = |k: ThreadType| format!("{svc}/api/{}/", if k == ThreadType::Group { "group" } else { "message" });
        let mut out = Vec::new();
        for a in &uploaded {
            let file_type = a["fileType"].as_str().unwrap_or_default();
            let thread = json!(thread_id);
            let params = if file_type == "image" {
                let p = obj(vec![
                    ("photoId", a["photoId"].clone()),
                    ("clientId", json!(client_id.to_string())),
                    ("desc", json!(msg)),
                    ("width", a["width"].clone()),
                    ("height", a["height"].clone()),
                    ("toid", some_if(!group, thread.clone())),
                    ("grid", some_if(group, thread.clone())),
                    ("rawUrl", a["normalUrl"].clone()),
                    ("hdUrl", a["hdUrl"].clone()),
                    ("thumbUrl", a["thumbUrl"].clone()),
                    ("oriUrl", some_if(group, a["normalUrl"].clone())),
                    ("normalUrl", some_if(!group, a["normalUrl"].clone())),
                    ("hdSize", json!(jstr(a.get("totalSize")))),
                    ("zsource", json!(-1)),
                    ("ttl", json!(ttl)),
                    ("jcp", json!(r#"{"convertible":"jxl"}"#)),
                    ("groupLayoutId", some_if(multi, json!(layout_id))),
                    ("isGroupLayout", some_if(multi, json!(1))),
                    ("idInGroup", some_if(multi, json!(index))),
                    ("totalItemInGroup", some_if(multi, json!(uploaded.len()))),
                    ("extMsgProp", some_if(multi, json!(format!(r#"{{"groupMediaMsg":{{"groupLayoutId":"{layout_id}"}}}}"#)))),
                    ("mentionInfo", some_if(mentions_ok && can_be_desc && !quoted, json!(Value::Array(mention_list.clone()).to_string()))),
                ]);
                client_id += 1;
                if multi {
                    index += 1;
                }
                p
            } else {
                let name = a["fileName"].as_str().unwrap_or_default();
                obj(vec![
                    ("fileId", a["fileId"].clone()),
                    ("checksum", a["checksum"].clone()),
                    ("checksumSha", json!("")),
                    ("extention", json!(file_ext(Path::new(name)))),
                    ("totalSize", a["totalSize"].clone()),
                    ("fileName", json!(name)),
                    ("clientId", a["clientFileId"].clone()),
                    ("fType", json!(1)),
                    ("fileCount", json!(0)),
                    ("fdata", json!("{}")),
                    ("toid", some_if(!group, thread.clone())),
                    ("grid", some_if(group, thread.clone())),
                    ("fileUrl", a["fileUrl"].clone()),
                    ("zsource", json!(-1)),
                    ("ttl", json!(ttl)),
                ])
            };
            let path = if file_type == "image" { "photo_original/send?" } else { "asyncfile/msg?" };
            let url = self.url(&format!("{}{path}", attach_base(kind)), &[("nretry", "0".into())])?;
            out.push(SendReq { url, body: Body::Form(vec![("params".into(), self.enc(&params)?)]) });
        }
        for gif in gifs {
            let (width, height) = image::image_dimensions(gif).map_err(|_| zerr("Failed to get gif metadata"))?;
            let bytes = tokio::fs::read(gif).await?;
            let name = file_name(gif);
            if self.exceeds_max_size(bytes.len() as u64) {
                return Err(zerr(format!("File {name} size exceed maximum size of {}MB", self.max_size_mb())));
            }
            let thumb = self.upthumb(&bytes, &attach_base(ThreadType::User)).await?;
            let params = obj(vec![
                ("clientId", json!(now_ms().to_string())),
                ("fileName", json!(name)),
                ("totalSize", json!(bytes.len())),
                ("width", json!(width)),
                ("height", json!(height)),
                ("msg", json!(msg)),
                ("type", json!(1)),
                ("ttl", json!(ttl)),
                ("visibility", some_if(group, json!(0))),
                ("toid", some_if(!group, json!(thread_id))),
                ("grid", some_if(group, json!(thread_id))),
                ("thumb", thumb.get("url").cloned().unwrap_or(Value::Null)),
                ("checksum", json!(md5_hex(&bytes))),
                ("totalChunk", json!(1)),
                ("chunkId", json!(1)),
            ]);
            let url = self.url(&format!("{}gif?", attach_base(kind)), &[("nretry", "0".into()), ("params", self.enc(&params)?), ("type", "1".into())])?;
            let part = Part::bytes(bytes).file_name(name).mime_str("application/octet-stream")?;
            out.push(SendReq { url, body: Body::Multipart(Form::new().part("chunkContent", part)) });
        }
        Ok(out)
    }

    /// `upthumb`: a GIF's thumbnail.
    async fn upthumb(&self, bytes: &[u8], base: &str) -> Result<Value> {
        let params = self.enc(&json!({ "clientId": now_ms(), "imei": self.imei }))?;
        let url = self.url(&format!("{base}upthumb?"), &[("params", params)])?;
        let part = Part::bytes(bytes.to_vec()).file_name("blob").mime_str("image/png")?;
        let r = self.http.request(&url, Method::POST, vec![], Body::Multipart(Form::new().part("fileContent", part))).await?;
        self.resolve(&r, true)
    }

    /// uploadAttachment.js: every chunk of every file at once; images come back with their URLs,
    /// other files once the socket reports them done.
    async fn upload_attachment(&self, files: &[&PathBuf], thread_id: &str, kind: ThreadType) -> Result<Vec<Value>> {
        if files.len() as f64 > self.max_file() {
            return Err(zerr(format!("Exceed maximum file of {}", jstr(Some(self.sharefile("max_file"))))));
        }
        if thread_id.is_empty() {
            return Err(zerr("Missing threadId"));
        }
        let chunk_size = self.sharefile("chunk_size_file").as_u64().filter(|&n| n > 0).unwrap_or(3 * 1024 * 1024) as usize;
        let group = kind == ThreadType::Group;
        let svc = self.svc("file")?;
        let url = format!("{svc}/api/{}/", if group { "group" } else { "message" });
        let type_param = if group { "11" } else { "2" };
        let restricted: Vec<String> = self.sharefile("restricted_ext_file").as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect();
        let first_id = now_ms();

        struct Prepared {
            kind: &'static str,
            name: String,
            bytes: Vec<u8>,
            size: u64,
            width: u32,
            height: u32,
            params: Value,
            chunks: usize,
        }
        let mut prepared = Vec::new();
        for (client_id, path) in (first_id..).zip(files) {
            if !path.exists() {
                return Err(zerr("File not found"));
            }
            let ext = file_ext(path).to_lowercase();
            let name = file_name(path);
            if restricted.contains(&ext) {
                return Err(zerr(format!("File extension \"{ext}\" is not allowed")));
            }
            let bytes = tokio::fs::read(path).await?;
            let size = bytes.len() as u64;
            let (file_kind, width, height) = match ext.as_str() {
                "jpg" | "jpeg" | "png" | "webp" => {
                    let (w, h) = image::image_dimensions(path).map_err(|_| zerr("Failed to get image metadata"))?;
                    ("image", w, h)
                }
                "mp4" => ("video", 0, 0),
                _ => ("others", 0, 0),
            };
            if self.exceeds_max_size(size) {
                return Err(zerr(format!("File {name} size exceed maximum size of {}MB", self.max_size_mb())));
            }
            let chunks = (size as usize).div_ceil(chunk_size);
            let (k, v) = dest(kind, thread_id);
            let params = obj(vec![
                (k, v),
                ("totalChunk", json!(chunks)),
                ("fileName", json!(name)),
                ("clientId", json!(client_id)),
                ("totalSize", json!(size)),
                ("imei", json!(self.imei)),
                ("isE2EE", json!(0)),
                ("jxl", json!(0)),
                ("chunkId", json!(1)),
            ]);
            prepared.push(Prepared { kind: file_kind, name, bytes, size, width, height, params, chunks });
        }

        let mut jobs = Vec::new();
        for (index, p) in prepared.iter().enumerate() {
            let checksum = if p.kind == "image" { String::new() } else { md5_hex(&p.bytes) };
            for i in 0..p.chunks {
                let mut params = p.params.clone();
                params["chunkId"] = json!(i + 1);
                let req_url = self.url(&format!("{url}{}", if p.kind == "image" { "photo_original/upload" } else { "asyncfile/upload" }), &[("type", type_param.into()), ("params", self.enc(&params)?)])?;
                let slice = p.bytes[i * chunk_size..((i + 1) * chunk_size).min(p.bytes.len())].to_vec();
                let part = Part::bytes(slice).file_name(p.name.clone()).mime_str("application/octet-stream")?;
                let checksum = checksum.clone();
                jobs.push(async move {
                    let r = self.http.request(&req_url, Method::POST, vec![], Body::Multipart(Form::new().part("chunkContent", part))).await?;
                    let res = self.resolve(&r, true)?;
                    if !(not_minus_one(res.get("fileId")) && not_minus_one(res.get("photoId"))) {
                        return Ok::<_, anyhow::Error>(None);
                    }
                    if p.kind == "image" {
                        return Ok(Some((index, json!({
                            "fileType": "image",
                            "width": p.width,
                            "height": p.height,
                            "totalSize": p.size,
                            "hdSize": p.size,
                            "finished": res.get("finished").cloned().unwrap_or(Value::Null),
                            "normalUrl": res.get("normalUrl").cloned().unwrap_or(Value::Null),
                            "hdUrl": res.get("hdUrl").cloned().unwrap_or(Value::Null),
                            "thumbUrl": res.get("thumbUrl").cloned().unwrap_or(Value::Null),
                            "chunkId": res.get("chunkId").cloned().unwrap_or(Value::Null),
                            "photoId": res.get("photoId").cloned().unwrap_or(Value::Null),
                            "clientFileId": res.get("clientFileId").cloned().unwrap_or(Value::Null),
                        }))));
                    }
                    // video / file: wait for the socket's `file_done`
                    let file_id = jstr(res.get("fileId"));
                    let (tx, rx) = oneshot::channel();
                    self.uploads.lock().insert(file_id, tx);
                    let ws = match tokio::time::timeout(Duration::from_secs(300), rx).await {
                        Ok(Ok(ws)) => ws,
                        // a later chunk of the same file took the wait over
                        Ok(Err(_)) => return Ok(None),
                        Err(_) => return Err(zerr(format!("Upload of {} timed out", p.name))),
                    };
                    let mut result = Map::new();
                    result.insert("fileType".into(), json!(p.kind));
                    if let Value::Object(m) = res {
                        result.extend(m);
                    }
                    if let Value::Object(m) = ws {
                        result.extend(m);
                    }
                    result.insert("totalSize".into(), json!(p.size));
                    result.insert("fileName".into(), json!(p.name));
                    result.insert("checksum".into(), json!(checksum));
                    Ok(Some((index, Value::Object(result))))
                });
            }
        }
        let mut results: Vec<Option<Value>> = vec![None; prepared.len()];
        for r in join_all(jobs).await {
            if let Some((i, v)) = r? {
                results[i] = Some(v);
            }
        }
        results.into_iter().enumerate().map(|(i, r)| r.ok_or_else(|| zerr(format!("Upload of {} failed", prepared[i].name)))).collect()
    }
}

/// `getClientMessageType`
fn client_message_type(msg_type: &str) -> i64 {
    match msg_type {
        "webchat" => 1,
        "chat.voice" => 31,
        "chat.photo" => 32,
        "chat.sticker" => 36,
        "chat.doodle" => 37,
        "chat.recommended" | "chat.link" => 38,
        "chat.video.msg" => 44,
        "share.file" => 46,
        "chat.gif" => 49,
        "chat.location.new" => 43,
        _ => 1,
    }
}

/// `prepareQMSG`: a quoted to-do's text.
fn prepare_qmsg(q: &Quote) -> Value {
    if q.msg_type == "chat.todo"
        && let Some(params) = q.content.get("params").and_then(Value::as_str)
        && let Ok(p) = serde_json::from_str::<Value>(params)
    {
        return p["item"]["content"].clone();
    }
    json!("")
}

/// `prepareQMSGAttach` (`None` = undefined: the field is left out).
fn prepare_qmsg_attach(q: &Quote) -> Option<Value> {
    if q.content.is_string() {
        return q.property_ext.clone();
    }
    if q.msg_type == "chat.todo" {
        return Some(json!({ "properties": { "color": 0, "size": 0, "type": 0, "subType": 0, "ext": r#"{"shouldParseLinkOrContact":0}"# } }));
    }
    let mut m = q.content.as_object().cloned().unwrap_or_default();
    for (k, from) in [("thumbUrl", "thumb"), ("oriUrl", "href"), ("normalUrl", "href")] {
        match q.content.get(from) {
            Some(v) => m.insert(k.into(), v.clone()),
            None => m.remove(k),
        };
    }
    Some(Value::Object(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_like_js() {
        // node: JSON.stringify(parseInt("7212345678901234567")) === "7212345678901235000"
        assert_eq!(js_parse_int_json("7212345678901234567"), "7212345678901235000");
        assert_eq!(js_parse_int_json("1731999999999"), "1731999999999");
        assert_eq!(js_parse_int_json("12abc"), "12");
        assert_eq!(js_parse_int_json("abc"), "null");
    }

    #[test]
    fn loose_error_codes() {
        assert!(code_ok(Some(&json!(0))) && code_ok(Some(&json!("0"))) && code_ok(Some(&json!(""))));
        assert!(!code_ok(None) && !code_ok(Some(&json!(-1))) && !code_ok(Some(&Value::Null)));
    }

    #[test]
    fn quote_attach() {
        let q = Quote {
            content: json!({ "href": "https://f", "thumb": "https://t", "title": "a.png" }),
            msg_type: "chat.photo".into(),
            property_ext: None,
            uid_from: "1".into(),
            msg_id: "2".into(),
            cli_msg_id: "3".into(),
            ts: "4".into(),
            ttl: Some(json!(0)),
        };
        assert_eq!(
            prepare_qmsg_attach(&q).unwrap(),
            json!({ "href": "https://f", "thumb": "https://t", "title": "a.png", "thumbUrl": "https://t", "oriUrl": "https://f", "normalUrl": "https://f" })
        );
        let text = Quote { content: json!("hi"), msg_type: "webchat".into(), ..q.clone() };
        assert_eq!(prepare_qmsg_attach(&text), None);
        assert_eq!(prepare_qmsg(&text), json!(""));
        let todo = Quote { content: json!({ "params": r#"{"item":{"content":"do it"}}"# }), msg_type: "chat.todo".into(), ..q };
        assert_eq!(prepare_qmsg(&todo), json!("do it"));
        assert_eq!(client_message_type("chat.photo"), 32);
        assert_eq!(reaction_type("/-heart"), 5);
        assert_eq!(reaction_type("??"), -1);
    }
}
