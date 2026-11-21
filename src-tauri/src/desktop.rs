//! Claude's tools for the other apps on the user's Windows desktop (MCP server "vibe-desktop").
//!
//! Off by default: a chat only gets this server once the user turns "Desktop control" on for it,
//! and only until the app restarts. Windows are read through UI Automation (numbered controls,
//! like browser_snapshot) and driven with the real mouse and keyboard (SendInput).

use std::{collections::HashSet, sync::LazyLock};

use parking_lot::Mutex;
use serde_json::{Value, json};

static ENABLED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

pub fn enabled(chat: &str) -> bool {
    ENABLED.lock().contains(chat)
}

#[tauri::command]
pub fn desktop_set(chat: String, on: bool) {
    if on {
        ENABLED.lock().insert(chat);
    } else {
        ENABLED.lock().remove(&chat);
    }
}

pub const INSTRUCTIONS: &str = "These tools see and operate the other apps open on the user's Windows desktop (the user turned them on for this chat). \
Start with desktop_list_windows, then desktop_snapshot of one window to get its numbered controls, then desktop_click / desktop_type / desktop_press_key with those numbers as `ref`. \
Take a new snapshot after the window changes. For apps whose controls don't show up in a snapshot (games, canvas or some Electron apps), use desktop_screenshot and click by x/y on it. \
To open an app, start it from the shell (e.g. `start notepad`), then list the windows. \
These use the user's real mouse and keyboard and bring the window to the front: ask the user before anything that sends, deletes, buys, pays, submits or changes settings, and never type passwords.";

pub fn tools() -> Value {
    let window = json!({ "type": "string", "description": "Window id from desktop_list_windows, or part of its title / program name" });
    json!([
        {
            "name": "desktop_list_windows",
            "description": "The app windows open on the desktop, front to back: id, title, program, size. VIBE CODE's own windows are left out.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "desktop_snapshot",
            "description": "Reads one window's controls (UI Automation) as an indented tree: a numbered line per button, field, menu item, list item, text… with its name and current value. Use the numbers as `ref` for desktop_click / desktop_type. Does not move the window or the mouse.",
            "inputSchema": { "type": "object", "properties": { "window": window }, "required": ["window"] }
        },
        {
            "name": "desktop_click",
            "description": "Click a control (`ref` from the last desktop_snapshot), or a point (`x`, `y` in pixels of the last desktop_screenshot). Brings its window to the front first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ref": { "type": "string" },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "button": { "type": "string", "enum": ["left", "right"] },
                    "double": { "type": "boolean" }
                }
            }
        },
        {
            "name": "desktop_type",
            "description": "Type text with the keyboard: into a control (`ref`, clicked first), into a `window` (brought to the front), or else into the window in front. `clear` selects all and deletes first; `submit` presses Enter after.",
            "inputSchema": {
                "type": "object",
                "properties": { "text": { "type": "string" }, "ref": { "type": "string" }, "window": window, "clear": { "type": "boolean" }, "submit": { "type": "boolean" } },
                "required": ["text"]
            }
        },
        {
            "name": "desktop_press_key",
            "description": "Press a key or shortcut in the window in front (or in `window`, brought to the front first), e.g. \"Enter\", \"Escape\", \"Tab\", \"Down\", \"Ctrl+S\", \"Alt+F4\", \"Ctrl+Shift+N\".",
            "inputSchema": { "type": "object", "properties": { "key": { "type": "string" }, "window": window }, "required": ["key"] }
        },
        {
            "name": "desktop_focus",
            "description": "Bring a window to the front (restoring it if minimized).",
            "inputSchema": { "type": "object", "properties": { "window": window }, "required": ["window"] }
        },
        {
            "name": "desktop_screenshot",
            "description": "Screenshot of one window (brought to the front first) or, without `window`, of the whole screen. desktop_click x/y are pixels of this image.",
            "inputSchema": { "type": "object", "properties": { "window": window } }
        }
    ])
}

/// MCP content for one tool call.
pub async fn call_tool(chat: &str, name: &str, args: Value) -> anyhow::Result<Value> {
    if !enabled(chat) {
        anyhow::bail!("Desktop control is off for this chat. The user can turn it on with the \"Desktop control\" button under the chat.");
    }
    imp::call(chat.to_owned(), name.to_owned(), args).await
}

#[cfg(not(windows))]
mod imp {
    use serde_json::Value;
    pub async fn call(_chat: String, _name: String, _args: Value) -> anyhow::Result<Value> {
        anyhow::bail!("Desktop control only works on Windows.")
    }
}

#[cfg(windows)]
mod imp {
    use std::{
        collections::HashMap,
        sync::{OnceLock, mpsc},
        time::Duration,
    };

    use anyhow::{Context, anyhow, bail};
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    use serde_json::{Value, json};
    use windows::{
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM, RECT},
            Graphics::Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
            System::{
                Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx},
                Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
            },
            UI::{
                Accessibility::{
                    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTogglePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern, ToggleState_On,
                    UIA_TogglePatternId, UIA_ValuePatternId,
                },
                Input::KeyboardAndMouse::{
                    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS,
                    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, SendInput, VIRTUAL_KEY, VkKeyScanW,
                },
                WindowsAndMessaging::{
                    EnumWindows, GWL_EXSTYLE, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
                    IsWindowVisible, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE, SetCursorPos, SetForegroundWindow, ShowWindow,
                    WS_EX_TOOLWINDOW,
                },
            },
        },
        core::{BOOL, BSTR, PWSTR},
    };

    /// Lines in one snapshot (big apps have thousands of controls).
    const MAX_REFS: usize = 500;
    /// Longest side of a screenshot (what Claude reads without shrinking it again).
    const MAX_SHOT: u32 = 1568;

    /// UI Automation is COM: one thread owns it and every element handed out.
    struct Worker {
        uia: IUIAutomation,
        walker: IUIAutomationTreeWalker,
        /// per chat: the window of the last snapshot and its numbered controls
        snaps: HashMap<String, (HWND, Vec<IUIAutomationElement>)>,
        /// per chat: where the last screenshot was taken (window, left, top, scale)
        shots: HashMap<String, (Option<HWND>, i32, i32, f64)>,
    }

    type Job = Box<dyn FnOnce(&mut Worker) + Send>;

    fn worker() -> &'static mpsc::Sender<Job> {
        static TX: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
        TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::spawn(move || {
                // SAFETY: COM initialised on this thread, which owns every UIA object below.
                let w = unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                    CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER).and_then(|uia| Ok((uia.ControlViewWalker()?, uia)))
                };
                // without UI Automation the receiver drops and every call reports it
                let Ok((walker, uia)) = w else { return };
                let mut w = Worker { uia, walker, snaps: HashMap::new(), shots: HashMap::new() };
                for job in rx {
                    job(&mut w);
                }
            });
            tx
        })
    }

    async fn run<T: Send + 'static>(f: impl FnOnce(&mut Worker) -> anyhow::Result<T> + Send + 'static) -> anyhow::Result<T> {
        const NO_UIA: &str = "Windows UI Automation is not available.";
        let (tx, rx) = tokio::sync::oneshot::channel();
        worker()
            .send(Box::new(move |w| {
                let _ = tx.send(f(w));
            }))
            .map_err(|_| anyhow!(NO_UIA))?;
        tokio::time::timeout(Duration::from_secs(60), rx).await.map_err(|_| anyhow!("The window did not respond within 60 s."))?.map_err(|_| anyhow!(NO_UIA))?
    }

    fn text(t: impl Into<String>) -> Value {
        json!([{ "type": "text", "text": t.into() }])
    }

    pub async fn call(chat: String, name: String, args: Value) -> anyhow::Result<Value> {
        run(move |w| match name.as_str() {
            "desktop_list_windows" => Ok(text(list_windows())),
            "desktop_snapshot" => snapshot(w, &chat, &args).map(text),
            "desktop_click" => click(w, &chat, &args).map(text),
            "desktop_type" => type_text(w, &chat, &args).map(text),
            "desktop_press_key" => {
                if let Some(spec) = args["window"].as_str() {
                    focus(find_window(spec)?)?;
                }
                press(args["key"].as_str().unwrap_or_default())?;
                Ok(text(after()))
            }
            "desktop_focus" => {
                let hwnd = find_window(args["window"].as_str().unwrap_or_default())?;
                focus(hwnd)?;
                Ok(text(format!("\"{}\" is in front.", title(hwnd))))
            }
            "desktop_screenshot" => screenshot(w, &chat, &args),
            _ => bail!("Unknown tool {name}"),
        })
        .await
    }

    /* ---------------- windows ---------------- */

    fn title(hwnd: HWND) -> String {
        let mut buf = [0u16; 512];
        // SAFETY: buffer-bounded read of a window title.
        let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn pid(hwnd: HWND) -> u32 {
        let mut pid = 0;
        // SAFETY: writes the process id into `pid`.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid
    }

    fn program(pid: u32) -> String {
        // SAFETY: the process handle is closed on every path; the buffer bounds the name.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().unwrap_or_default().to_owned()
        }
    }

    /// Visible bounds of a window (without the invisible resize border Windows adds).
    fn rect(hwnd: HWND) -> RECT {
        let mut r = RECT::default();
        // SAFETY: both calls write one RECT.
        unsafe {
            if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, (&raw mut r).cast(), size_of::<RECT>() as u32).is_err() {
                let _ = GetWindowRect(hwnd, &mut r);
            }
        }
        r
    }

    /// Top-level app windows a person would see in the taskbar / Alt+Tab, front to back.
    fn app_windows() -> Vec<HWND> {
        unsafe extern "system" fn each(hwnd: HWND, lp: LPARAM) -> BOOL {
            // SAFETY: `lp` is the Vec passed to EnumWindows below, alive for the whole call.
            unsafe { (*(lp.0 as *mut Vec<HWND>)).push(hwnd) };
            BOOL(1)
        }
        let mut all: Vec<HWND> = Vec::new();
        // SAFETY: the callback only pushes into `all`.
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&raw mut all as isize));
        }
        let me = std::process::id();
        all.into_iter()
            .filter(|&h| {
                // SAFETY: read-only queries on a window handle.
                unsafe {
                    let mut cloaked = 0u32;
                    let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&raw mut cloaked).cast(), 4);
                    IsWindowVisible(h).as_bool()
                        && cloaked == 0
                        && GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 == 0
                        && pid(h) != me
                        && !title(h).trim().is_empty()
                }
            })
            .collect()
    }

    fn list_windows() -> String {
        let lines: Vec<String> = app_windows()
            .into_iter()
            .map(|h| {
                let r = rect(h);
                // SAFETY: read-only query.
                let min = if unsafe { IsIconic(h) }.as_bool() { " (minimized)".to_owned() } else { format!(" {}x{}", r.right - r.left, r.bottom - r.top) };
                format!("id {} — \"{}\" [{}]{min}", h.0 as isize, title(h), program(pid(h)))
            })
            .collect();
        if lines.is_empty() { "No app windows are open.".into() } else { lines.join("\n") }
    }

    /// `spec`: a window id from desktop_list_windows, or part of a title / program name.
    fn find_window(spec: &str) -> anyhow::Result<HWND> {
        let spec = spec.trim();
        if spec.is_empty() {
            bail!("Pass `window`: an id from desktop_list_windows, or part of its title.");
        }
        let wins = app_windows();
        if let Ok(id) = spec.parse::<isize>()
            && let Some(&h) = wins.iter().find(|h| h.0 as isize == id)
        {
            return Ok(h);
        }
        let low = spec.to_lowercase();
        wins.iter()
            .copied()
            .find(|&h| title(h).to_lowercase().contains(&low))
            .or_else(|| wins.iter().copied().find(|&h| program(pid(h)).to_lowercase().contains(&low)))
            .with_context(|| format!("No window matches \"{spec}\". Call desktop_list_windows."))
    }

    /// Brings `hwnd` to the front; fails unless that app really is in front afterwards.
    fn focus(hwnd: HWND) -> anyhow::Result<()> {
        // SAFETY: plain window-manager calls.
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            if GetForegroundWindow() != hwnd && !SetForegroundWindow(hwnd).as_bool() {
                // Windows only lets the app that got the last input take the foreground: tap Alt
                send(&[key(0x12, 0, KEYBD_EVENT_FLAGS(0)), key(0x12, 0, KEYEVENTF_KEYUP)]);
                let _ = SetForegroundWindow(hwnd);
            }
        }
        std::thread::sleep(Duration::from_millis(150));
        // a dialog of the same app may be the one in front: that is where input should go
        if !front_is(pid(hwnd)) {
            bail!("Windows would not bring \"{}\" to the front. Ask the user to click on it once.", title(hwnd));
        }
        Ok(())
    }

    fn front_is(pid_: u32) -> bool {
        // SAFETY: read-only query.
        pid(unsafe { GetForegroundWindow() }) == pid_
    }

    /// Input goes to the window in front: never let it land in VIBE CODE itself (this chat's terminal).
    fn guard_front() -> anyhow::Result<()> {
        if front_is(std::process::id()) {
            bail!("VIBE CODE is in front, so keys would go into this chat. Pass `window` (or `ref`) so the target app is brought to the front first.");
        }
        Ok(())
    }

    /// What is in front once an action had a moment to take effect.
    fn after() -> String {
        std::thread::sleep(Duration::from_millis(400));
        // SAFETY: read-only query.
        let h = unsafe { GetForegroundWindow() };
        format!("ok — in front: \"{}\" [{}]", title(h), program(pid(h)))
    }

    /* ---------------- snapshot ---------------- */

    const TYPES: [&str; 41] = [
        "button", "calendar", "checkbox", "combobox", "edit", "link", "image", "listitem", "list", "menu", "menubar", "menuitem", "progressbar", "radio", "scrollbar", "slider",
        "spinner", "statusbar", "tab", "tabitem", "text", "toolbar", "tooltip", "tree", "treeitem", "custom", "group", "thumb", "datagrid", "dataitem", "document",
        "splitbutton", "window", "pane", "header", "headeritem", "table", "titlebar", "separator", "semanticzoom", "appbar",
    ];

    enum Node {
        /// leave it and everything inside out
        Skip,
        /// not worth a line, but look inside
        Through,
        Show(String),
    }

    fn short(s: &str, max: usize) -> String {
        let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if s.chars().count() > max { format!("{}…", s.chars().take(max).collect::<String>()) } else { s }
    }

    fn describe(el: &IUIAutomationElement) -> Node {
        // SAFETY: property reads on an element owned by this thread.
        unsafe {
            if el.CurrentIsOffscreen().is_ok_and(|b| b.as_bool()) {
                return Node::Skip;
            }
            let ty = el.CurrentControlType().map(|t| t.0 - 50000).unwrap_or(-1);
            let kind = TYPES.get(ty as usize).copied().unwrap_or("element");
            if matches!(kind, "scrollbar" | "thumb" | "separator") {
                return Node::Skip;
            }
            let name = short(&el.CurrentName().map(|b| b.to_string()).unwrap_or_default(), 100);
            if name.is_empty() && matches!(kind, "pane" | "group" | "custom" | "text" | "element" | "window" | "image") {
                return Node::Through;
            }
            let mut line = format!("{kind} \"{name}\"");
            if matches!(kind, "edit" | "combobox" | "document" | "spinner" | "slider")
                && !el.CurrentIsPassword().is_ok_and(|b| b.as_bool())
                && let Ok(v) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                && let Ok(v) = v.CurrentValue()
            {
                let v = v.to_string();
                if !v.is_empty() && v != name {
                    line += &format!(" value=\"{}\"", short(&v, if kind == "document" { 2000 } else { 200 }));
                }
            }
            if kind == "checkbox"
                && let Ok(t) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                && t.CurrentToggleState().is_ok_and(|s| s == ToggleState_On)
            {
                line += " (checked)";
            }
            if el.CurrentIsEnabled().is_ok_and(|b| !b.as_bool()) {
                line += " (disabled)";
            }
            Node::Show(line)
        }
    }

    fn walk(w: &Worker, el: &IUIAutomationElement, depth: usize, refs: &mut Vec<IUIAutomationElement>, lines: &mut Vec<String>) {
        // SAFETY: tree navigation on elements owned by this thread.
        let mut child = unsafe { w.walker.GetFirstChildElement(el) }.ok();
        while let Some(c) = child {
            if refs.len() >= MAX_REFS || depth > 40 {
                return;
            }
            match describe(&c) {
                Node::Skip => {}
                Node::Through => walk(w, &c, depth, refs, lines),
                Node::Show(line) => {
                    refs.push(c.clone());
                    lines.push(format!("{}[{}] {line}", "  ".repeat(depth), refs.len()));
                    walk(w, &c, depth + 1, refs, lines);
                }
            }
            child = unsafe { w.walker.GetNextSiblingElement(&c) }.ok();
        }
    }

    fn snapshot(w: &mut Worker, chat: &str, args: &Value) -> anyhow::Result<String> {
        let hwnd = find_window(args["window"].as_str().unwrap_or_default())?;
        let head = format!("Window id {} — \"{}\" [{}]", hwnd.0 as isize, title(hwnd), program(pid(hwnd)));
        // SAFETY: read-only query.
        if unsafe { IsIconic(hwnd) }.as_bool() {
            return Ok(format!("{head} is minimized: call desktop_focus first."));
        }
        // SAFETY: UIA call on this thread.
        let root = unsafe { w.uia.ElementFromHandle(hwnd) }.context("UI Automation cannot read this window")?;
        let (mut refs, mut lines) = (Vec::new(), Vec::new());
        walk(w, &root, 0, &mut refs, &mut lines);
        let more = if refs.len() >= MAX_REFS { format!("\n(stopped at {MAX_REFS} controls)") } else { String::new() };
        let body = if lines.is_empty() { "(no controls exposed — use desktop_screenshot and click by x/y)".to_owned() } else { lines.join("\n") };
        w.snaps.insert(chat.to_owned(), (hwnd, refs));
        Ok(format!("{head}\n\n{body}{more}"))
    }

    /// The control numbered `r` in this chat's last snapshot, and its window.
    fn element(w: &Worker, chat: &str, r: &Value) -> anyhow::Result<(HWND, IUIAutomationElement)> {
        let n: usize = r.as_str().map(str::to_owned).unwrap_or_else(|| r.to_string()).trim().parse().context("`ref` is a number from desktop_snapshot")?;
        let (hwnd, refs) = w.snaps.get(chat).context("Take a desktop_snapshot first.")?;
        let el = n.checked_sub(1).and_then(|i| refs.get(i)).context("No such ref: take a new desktop_snapshot.")?;
        Ok((*hwnd, el.clone()))
    }

    /* ---------------- input ---------------- */

    fn key(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
        INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, ..Default::default() } } }
    }

    fn send(inputs: &[INPUT]) {
        // SAFETY: a slice of fully initialised INPUTs.
        unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    }

    fn click_at(x: i32, y: i32, right: bool, double: bool) -> anyhow::Result<()> {
        guard_front()?;
        // SAFETY: moves the cursor (physical pixels: the app is per-monitor DPI aware).
        unsafe { SetCursorPos(x, y) }?;
        let (down, up) = if right { (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) } else { (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP) };
        send(&[mouse(down), mouse(up)]);
        if double {
            send(&[mouse(down), mouse(up)]);
        }
        Ok(())
    }

    /// Clicks the middle of a control from the last snapshot.
    fn click_ref(w: &Worker, chat: &str, r: &Value, right: bool, double: bool) -> anyhow::Result<()> {
        let (hwnd, el) = element(w, chat, r)?;
        focus(hwnd)?;
        // SAFETY: property read on this thread.
        let b = unsafe { el.CurrentBoundingRectangle() }?;
        if b.right <= b.left || b.bottom <= b.top {
            bail!("That control is not on screen (scrolled away or closed): take a new desktop_snapshot.");
        }
        click_at((b.left + b.right) / 2, (b.top + b.bottom) / 2, right, double)
    }

    fn click(w: &mut Worker, chat: &str, args: &Value) -> anyhow::Result<String> {
        let right = args["button"].as_str() == Some("right");
        let double = args["double"].as_bool().unwrap_or(false);
        if let Some(r) = args.get("ref").filter(|v| !v.is_null()) {
            click_ref(w, chat, r, right, double)?;
        } else if let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) {
            let &(win, left, top, scale) = w.shots.get(chat).context("x/y are pixels of a desktop_screenshot: take one first.")?;
            if let Some(h) = win {
                focus(h)?;
            }
            click_at(left + (x / scale).round() as i32, top + (y / scale).round() as i32, right, double)?;
        } else {
            bail!("Pass `ref` (from desktop_snapshot) or `x` and `y` (on the last desktop_screenshot).");
        }
        Ok(after())
    }

    fn type_text(w: &mut Worker, chat: &str, args: &Value) -> anyhow::Result<String> {
        let mut clear = args["clear"].as_bool().unwrap_or(false);
        if let Some(r) = args.get("ref").filter(|v| !v.is_null()) {
            click_ref(w, chat, r, false, false)?;
            // empty the field directly where it allows it: not every app selects all on Ctrl+A
            if clear
                && let Ok((_, el)) = element(w, chat, r)
                // SAFETY: pattern calls on an element owned by this thread.
                && let Ok(v) = unsafe { el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
                && unsafe { v.SetValue(&BSTR::new()) }.is_ok()
            {
                clear = false;
            }
        } else if let Some(spec) = args["window"].as_str() {
            focus(find_window(spec)?)?;
        }
        guard_front()?;
        if clear {
            press("Ctrl+A")?;
            press("Delete")?;
        }
        let mut inputs = Vec::new();
        for unit in args["text"].as_str().unwrap_or_default().encode_utf16() {
            match unit {
                0x0D => {}
                // as keys, so editors start a new line / move to the next field
                0x0A | 0x09 => {
                    let vk = if unit == 0x0A { 0x0D } else { 0x09 };
                    inputs.extend([key(vk, 0, KEYBD_EVENT_FLAGS(0)), key(vk, 0, KEYEVENTF_KEYUP)]);
                }
                _ => inputs.extend([key(0, unit, KEYEVENTF_UNICODE), key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]),
            }
        }
        for chunk in inputs.chunks(200) {
            send(chunk);
            std::thread::sleep(Duration::from_millis(10));
        }
        if args["submit"].as_bool().unwrap_or(false) {
            press("Enter")?;
        }
        Ok(after())
    }

    /// Virtual-key code of one key name; `true` for keys that need the extended flag.
    fn vk(name: &str) -> Option<(u16, bool)> {
        let n = name.trim().to_lowercase();
        let named = match n.as_str() {
            "enter" | "return" => (0x0D, false),
            "esc" | "escape" => (0x1B, false),
            "tab" => (0x09, false),
            "backspace" => (0x08, false),
            "space" => (0x20, false),
            "delete" | "del" => (0x2E, true),
            "insert" | "ins" => (0x2D, true),
            "home" => (0x24, true),
            "end" => (0x23, true),
            "pageup" | "pgup" => (0x21, true),
            "pagedown" | "pgdn" => (0x22, true),
            "up" | "arrowup" => (0x26, true),
            "down" | "arrowdown" => (0x28, true),
            "left" | "arrowleft" => (0x25, true),
            "right" | "arrowright" => (0x27, true),
            "ctrl" | "control" => (0x11, false),
            "shift" => (0x10, false),
            "alt" => (0x12, false),
            "win" | "windows" | "meta" | "cmd" => (0x5B, true),
            "apps" | "menu" => (0x5D, true),
            "printscreen" => (0x2C, false),
            _ => {
                if let Some(f) = n.strip_prefix('f').and_then(|d| d.parse::<u16>().ok()).filter(|f| (1..=24).contains(f)) {
                    return Some((0x70 + f - 1, false));
                }
                let mut chars = n.chars();
                let (Some(c), None) = (chars.next(), chars.next()) else { return None };
                if c.is_ascii_alphanumeric() {
                    return Some((c.to_ascii_uppercase() as u16, false));
                }
                // SAFETY: pure keyboard-layout lookup.
                let k = unsafe { VkKeyScanW(c as u16) };
                return (k != -1).then_some(((k & 0xFF) as u16, false));
            }
        };
        Some(named)
    }

    /// Presses a key or chord like "Ctrl+Shift+S" in the window in front.
    fn press(spec: &str) -> anyhow::Result<()> {
        guard_front()?;
        let keys: Vec<(u16, bool)> = spec
            .split('+')
            .filter(|p| !p.trim().is_empty())
            .map(|p| vk(p).with_context(|| format!("Unknown key \"{}\".", p.trim())))
            .collect::<anyhow::Result<_>>()?;
        if keys.is_empty() {
            bail!("Pass `key`, e.g. \"Enter\" or \"Ctrl+S\".");
        }
        let flag = |ext: bool| if ext { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) };
        let mut inputs: Vec<INPUT> = keys.iter().map(|&(k, ext)| key(k, 0, flag(ext))).collect();
        inputs.extend(keys.iter().rev().map(|&(k, ext)| key(k, 0, flag(ext) | KEYEVENTF_KEYUP)));
        send(&inputs);
        Ok(())
    }

    /* ---------------- screenshot ---------------- */

    fn screenshot(w: &mut Worker, chat: &str, args: &Value) -> anyhow::Result<Value> {
        let (win, x, y, width, height) = match args["window"].as_str().filter(|s| !s.trim().is_empty()) {
            Some(spec) => {
                let h = find_window(spec)?;
                // only what is on screen gets captured
                focus(h)?;
                std::thread::sleep(Duration::from_millis(150));
                let r = rect(h);
                (Some(h), r.left, r.top, (r.right - r.left).max(1) as u32, (r.bottom - r.top).max(1) as u32)
            }
            // SAFETY: plain metric reads.
            None => unsafe {
                (
                    None,
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                    GetSystemMetrics(SM_CXVIRTUALSCREEN) as u32,
                    GetSystemMetrics(SM_CYVIRTUALSCREEN) as u32,
                )
            },
        };
        let px = crate::capture::grab(x, y, width, height).context("Could not capture the screen.")?;
        let scale = (MAX_SHOT as f64 / width.max(height) as f64).min(1.0);
        let (nw, nh) = (((width as f64 * scale).round() as u32).max(1), ((height as f64 * scale).round() as u32).max(1));
        let px = if scale < 1.0 { shrink(&px, width, height, nw, nh) } else { px };
        let mut png_bytes = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut png_bytes, nw, nh);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header()?.write_image_data(&px)?;
        }
        w.shots.insert(chat.to_owned(), (win, x, y, nw as f64 / width as f64));
        let what = win.map(|h| format!("\"{}\"", title(h))).unwrap_or_else(|| "the whole screen".into());
        Ok(json!([
            { "type": "image", "data": B64.encode(&png_bytes), "mimeType": "image/png" },
            { "type": "text", "text": format!("{what}, {nw}x{nh} px. desktop_click x/y are pixels of this image.") }
        ]))
    }

    /// Box-filter downscale of RGBA pixels (keeps text readable, unlike skipping pixels).
    fn shrink(px: &[u8], w: u32, h: u32, nw: u32, nh: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity((nw * nh * 4) as usize);
        for dy in 0..nh {
            let (y0, y1) = ((dy * h / nh) as usize, (((dy + 1) * h / nh).max(dy * h / nh + 1)) as usize);
            for dx in 0..nw {
                let (x0, x1) = ((dx * w / nw) as usize, (((dx + 1) * w / nw).max(dx * w / nw + 1)) as usize);
                let mut sum = [0u32; 4];
                for y in y0..y1 {
                    for x in x0..x1 {
                        let i = (y * w as usize + x) * 4;
                        for c in 0..4 {
                            sum[c] += px[i + c] as u32;
                        }
                    }
                }
                let n = ((y1 - y0) * (x1 - x0)) as u32;
                out.extend(sum.map(|s| (s / n) as u8));
            }
        }
        out
    }
}
