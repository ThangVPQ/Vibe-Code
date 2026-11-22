//! File Explorer search: one parallel walk of the folder (or every drive, from This PC) into an in-memory index,
//! then every keystroke ranks names against that index — instant after the first pass, and results show while
//! the walk is still going. Matching ignores case and Vietnamese accents ("tai lieu" finds "Tài liệu").

use std::{
    path::{MAIN_SEPARATOR, PathBuf},
    sync::{
        Arc, LazyLock, Once, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex, RwLock};
use serde::Serialize;

use crate::core::{Res, emit};

/// folders listed but not walked into: huge and never what you're looking for
const NO_DESCEND: [&str; 6] = [".git", "node_modules", "$Recycle.Bin", "System Volume Information", "$WinREAgent", "WinSxS"];
const TOP: usize = 1000;
/// a search started on an index older than this walks the folder again
const STALE: Duration = Duration::from_secs(30);
/// an index nobody searched for this long is dropped (one of all drives holds a few hundred MB)
const IDLE_SECS: u64 = 300;

/// a folder that was read: its path, and the names of what's in it, each followed by its key when that differs
struct Folder {
    path: Box<str>,
    text: Box<str>,
}

const DIR: u8 = 1;
/// hidden itself or inside a hidden folder
const HIDDEN: u8 = 2;
/// inside a dot-folder or AppData: caches and tools, ranked below your own files
const NOISE: u8 = 4;

/// 32 bytes: the names live in their folder's `text`
struct Item {
    folder: u32,
    /// the name is text[at..at + name_len]; the key (the name folded: lowercase, no accents) right after it,
    /// or key_len 0 when the name is its own key
    at: u32,
    name_len: u16,
    key_len: u16,
    depth: u16,
    flags: u8,
    size: u64,
    modified: f64,
}

#[derive(Default)]
struct Store {
    folders: Vec<Folder>,
    items: Vec<Item>,
}

impl Store {
    fn name(&self, it: &Item) -> &str {
        let at = it.at as usize;
        &self.folders[it.folder as usize].text[at..at + it.name_len as usize]
    }
    fn key(&self, it: &Item) -> &str {
        if it.key_len == 0 {
            return self.name(it);
        }
        let at = it.at as usize + it.name_len as usize;
        &self.folders[it.folder as usize].text[at..at + it.key_len as usize]
    }
    /// the folder it's in
    fn dir(&self, it: &Item) -> &str {
        &self.folders[it.folder as usize].path
    }
}

struct Index {
    root: String,
    store: RwLock<Store>,
    done: AtomicBool,
    cancel: AtomicBool,
    built: Instant,
    last_emit: AtomicU64,
    /// seconds since START of the last search
    used: AtomicU64,
}

static INDEXES: LazyLock<Mutex<Vec<Arc<Index>>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static START: LazyLock<Instant> = LazyLock::new(Instant::now);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    root: &'a str,
    indexed: usize,
    done: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: f64,
    hidden: bool,
    /// the folder it's in, relative to where the search started
    at: String,
    /// matched characters of the name: [start, end) pairs, in chars
    marks: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    hits: Vec<Hit>,
    /// matches in all (only the best TOP are sent)
    total: usize,
    indexed: usize,
    done: bool,
}

/// `root` "" is This PC: every local drive. `fresh`: a new search, so an old index is walked again.
#[tauri::command]
pub async fn fs_search(root: String, query: String, hidden: bool, fresh: bool) -> Res<Found> {
    let ix = index_for(&root, fresh);
    ix.used.store(START.elapsed().as_secs(), Ordering::Relaxed);
    let ticket = TICKET.fetch_add(1, Ordering::Relaxed) + 1;
    tokio::task::spawn_blocking(move || search(&ix, &query, hidden, ticket)).await?.ok_or_else(|| crate::core::Error("superseded".into()))
}

/// the newest search: older ones still running stop, so typing never waits behind a stale query
static TICKET: AtomicU64 = AtomicU64::new(0);

/// the last search's matches: typing one more letter only looks at those (and at what the walk added since)
struct Last {
    ix: Weak<Index>,
    query: String,
    hidden: bool,
    indexed: usize,
    matched: Vec<usize>,
}
static LAST: Mutex<Option<Last>> = Mutex::new(None);

/// F5 and file changes made here: the next search walks again
#[tauri::command]
pub async fn fs_search_forget() -> Res<()> {
    for ix in INDEXES.lock().drain(..) {
        ix.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn index_for(root: &str, fresh: bool) -> Arc<Index> {
    static REAPER: Once = Once::new();
    REAPER.call_once(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(60));
                let now = START.elapsed().as_secs();
                INDEXES.lock().retain(|ix| !ix.done.load(Ordering::Relaxed) || now < ix.used.load(Ordering::Relaxed) + IDLE_SECS);
                let mut last = LAST.lock();
                if last.as_ref().is_some_and(|l| l.ix.strong_count() == 0) {
                    *last = None;
                }
            }
        });
    });
    let mut all = INDEXES.lock();
    if let Some(i) = all.iter().position(|ix| ix.root.eq_ignore_ascii_case(root)) {
        let ix = &all[i];
        if !(fresh && ix.done.load(Ordering::Relaxed) && ix.built.elapsed() > STALE) {
            return ix.clone();
        }
        all.remove(i);
    }
    let ix = Arc::new(Index {
        root: root.to_owned(),
        store: RwLock::new(Store::default()),
        done: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        built: Instant::now(),
        last_emit: AtomicU64::new(0),
        used: AtomicU64::new(START.elapsed().as_secs()),
    });
    // two indexes at most: the folder you're in and the one you came from
    while all.len() >= 2 {
        all.remove(0).cancel.store(true, Ordering::Relaxed);
    }
    all.push(ix.clone());
    let walker = ix.clone();
    std::thread::spawn(move || walk(&walker));
    ix
}

/* ================================ the walk ================================ */

struct Dir {
    path: PathBuf,
    depth: u16,
    hidden: bool,
    noise: bool,
}

/// every folder below the root(s), read by a few threads sharing one queue of folders
fn walk(ix: &Index) {
    let tops: Vec<PathBuf> = if ix.root.is_empty() {
        crate::fsx::local_drives()
    } else {
        vec![PathBuf::from(&ix.root)]
    };
    let queue = Mutex::new((tops.into_iter().map(|path| Dir { path, depth: 0, hidden: false, noise: false }).collect::<Vec<_>>(), 0usize));
    let wake = Condvar::new();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                loop {
                    let dir = {
                        let mut q = queue.lock();
                        loop {
                            if ix.cancel.load(Ordering::Relaxed) {
                                q.0.clear();
                            }
                            if let Some(d) = q.0.pop() {
                                q.1 += 1;
                                break d;
                            }
                            if q.1 == 0 {
                                wake.notify_all();
                                return;
                            }
                            wake.wait(&mut q);
                        }
                    };
                    let (folder, mut items, subdirs) = read(&dir);
                    if !items.is_empty() {
                        let mut st = ix.store.write();
                        let id = st.folders.len() as u32;
                        st.folders.push(folder);
                        items.iter_mut().for_each(|it| it.folder = id);
                        st.items.append(&mut items);
                        drop(st);
                        progress(ix, false);
                    }
                    let mut q = queue.lock();
                    q.0.extend(subdirs);
                    q.1 -= 1;
                    wake.notify_all();
                }
            });
        }
    });
    ix.done.store(true, Ordering::Relaxed);
    progress(ix, true);
}

fn read(dir: &Dir) -> (Folder, Vec<Item>, Vec<Dir>) {
    let mut text = String::new();
    let mut items = Vec::new();
    let mut subdirs = Vec::new();
    let drive_root = dir.depth == 0 && dir.path.parent().is_none();
    for e in std::fs::read_dir(&dir.path).into_iter().flatten().flatten() {
        // on Windows this comes with the directory listing: no extra call per file
        let Ok(meta) = e.metadata() else { continue };
        let ft = meta.file_type();
        let name = e.file_name().to_string_lossy().into_owned();
        #[cfg(windows)]
        let (is_dir, hidden) = {
            use std::os::windows::fs::{FileTypeExt, MetadataExt};
            (ft.is_dir() || ft.is_symlink_dir(), meta.file_attributes() & 0x6 != 0)
        };
        #[cfg(not(windows))]
        let (is_dir, hidden) = (ft.is_dir(), name.starts_with('.'));
        let hidden = hidden || dir.hidden;
        // links and junctions are listed, not followed (they loop: "Application Data" → AppData\Roaming…)
        if is_dir && !ft.is_symlink() && !NO_DESCEND.contains(&name.as_str()) && !(drive_root && name.eq_ignore_ascii_case("Windows")) {
            let noise = dir.noise || name.starts_with('.') || name == "AppData";
            subdirs.push(Dir { path: e.path(), depth: dir.depth + 1, hidden, noise });
        }
        let key: String = name.chars().map(fold).collect();
        let key_len = if key == name { 0 } else { key.len() };
        let at = text.len();
        text.push_str(&name);
        if key_len > 0 {
            text.push_str(&key);
        }
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_millis() as f64);
        items.push(Item {
            folder: 0,
            at: at as u32,
            name_len: name.len() as u16,
            key_len: key_len as u16,
            depth: dir.depth,
            flags: if is_dir { DIR } else { 0 } | if hidden { HIDDEN } else { 0 } | if dir.noise { NOISE } else { 0 },
            size: if is_dir { 0 } else { meta.len() },
            modified,
        });
    }
    let folder = Folder { path: dir.path.to_string_lossy().into(), text: text.into() };
    (folder, items, subdirs)
}

/// at most five times a second while walking, then once at the end
fn progress(ix: &Index, done: bool) {
    let now = ix.built.elapsed().as_millis() as u64;
    let last = ix.last_emit.load(Ordering::Relaxed);
    if !done && now < last + 200 {
        return;
    }
    if !done && ix.last_emit.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_err() {
        return;
    }
    if ix.cancel.load(Ordering::Relaxed) {
        return;
    }
    emit("fs:search-progress", (Progress { root: &ix.root, indexed: ix.store.read().items.len(), done },));
}

/* ================================ matching ================================ */

/// lowercase, without accents: the same number of chars as the name, so match positions are name positions
fn fold(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let l = c.to_lowercase().next().unwrap_or(c);
    match l {
        'à' | 'á' | 'ả' | 'ã' | 'ạ' | 'ă' | 'ằ' | 'ắ' | 'ẳ' | 'ẵ' | 'ặ' | 'â' | 'ầ' | 'ấ' | 'ẩ' | 'ẫ' | 'ậ' | 'ä' | 'å' => 'a',
        'è' | 'é' | 'ẻ' | 'ẽ' | 'ẹ' | 'ê' | 'ề' | 'ế' | 'ể' | 'ễ' | 'ệ' | 'ë' => 'e',
        'ì' | 'í' | 'ỉ' | 'ĩ' | 'ị' | 'î' | 'ï' => 'i',
        'ò' | 'ó' | 'ỏ' | 'õ' | 'ọ' | 'ô' | 'ồ' | 'ố' | 'ổ' | 'ỗ' | 'ộ' | 'ơ' | 'ờ' | 'ớ' | 'ở' | 'ỡ' | 'ợ' | 'ö' => 'o',
        'ù' | 'ú' | 'ủ' | 'ũ' | 'ụ' | 'ư' | 'ừ' | 'ứ' | 'ử' | 'ữ' | 'ự' | 'û' | 'ü' => 'u',
        'ỳ' | 'ý' | 'ỷ' | 'ỹ' | 'ỵ' => 'y',
        'đ' => 'd',
        'ç' => 'c',
        'ñ' => 'n',
        _ => l,
    }
}

/// where a word starts: the beginning, after a separator, or a capital after a small letter (FileExplorer)
fn word_start(name: &[char], i: usize) -> bool {
    i == 0 || !name[i - 1].is_alphanumeric() || (name[i].is_uppercase() && name[i - 1].is_lowercase()) || (name[i].is_ascii_digit() && !name[i - 1].is_ascii_digit())
}

/// how well one term matches a name, and which chars it matched
fn score_term(term: &[char], key: &[char], name: &[char], marks: &mut Vec<u32>) -> Option<i32> {
    let n = term.len();
    if n == 0 || n > key.len() {
        return None;
    }
    // "*.pdf": ends with
    if term[0] == '*' {
        let rest = &term[1..];
        return key.ends_with(rest).then(|| {
            marks.extend([(key.len() - rest.len()) as u32, key.len() as u32]);
            300
        });
    }
    if key == term {
        marks.extend([0, n as u32]);
        return Some(1000);
    }
    // a substring: the best of its places (a word start beats the middle of a word)
    let mut best: Option<(i32, usize)> = None;
    for i in 0..=key.len() - n {
        if key[i..i + n] == *term {
            let s = if i == 0 {
                // the whole name but the extension: "readme" → README.md
                if key.get(n) == Some(&'.') && !key[n + 1..].contains(&'.') { 900 } else { 800 }
            } else if word_start(name, i) {
                600
            } else {
                400
            };
            if best.is_none_or(|(b, _)| s > b) {
                best = Some((s, i));
            }
            if s >= 800 {
                break;
            }
        }
    }
    if let Some((s, i)) = best {
        marks.extend([i as u32, (i + n) as u32]);
        return Some(s);
    }
    // initials and word pieces: "fe" → FileExplorer, "bkinv" → bkav_invoice
    if n < 2 {
        return None;
    }
    let start = marks.len();
    let (mut t, mut k, mut runs) = (0, 0, 0);
    while t < n && k < key.len() {
        let joined = marks.len() > start && marks[marks.len() - 1] as usize == k;
        if key[k] == term[t] && (joined || word_start(name, k)) {
            if joined {
                *marks.last_mut().unwrap() += 1;
            } else {
                marks.extend([k as u32, k as u32 + 1]);
                runs += 1;
            }
            t += 1;
        }
        k += 1;
    }
    // scattered single letters in a long term are noise: "lieu" → "-l-i-b-r-a-r-y_-e-l-e-m-e-n-t-s"
    if t < n || (n > 3 && n < runs * 2) {
        marks.truncate(start);
        return None;
    }
    Some(250 - 10 * runs as i32)
}

struct Term {
    chars: Vec<char>,
    text: String,
    /// what must appear in the name, in order, for any kind of match (the part after a leading "*")
    must: Vec<u8>,
}

/// all of `needle`'s bytes in `hay`, in order: the cheap test that throws out almost every name
fn in_order(hay: &[u8], needle: &[u8]) -> bool {
    let mut h = 0;
    for &b in needle {
        while h < hay.len() && hay[h] != b {
            h += 1;
        }
        if h == hay.len() {
            return false;
        }
        h += 1;
    }
    true
}

/// reused for every item a thread looks at
#[derive(Default)]
struct Scratch {
    key: Vec<char>,
    name: Vec<char>,
    marks: Vec<u32>,
    missed: Vec<usize>,
}

fn rank(terms: &[Term], st: &Store, it: &Item, hidden: bool, w: &mut Scratch) -> Option<i32> {
    if it.flags & HIDDEN != 0 && !hidden {
        return None;
    }
    let key = st.key(it);
    if !terms.iter().any(|t| in_order(key.as_bytes(), &t.must)) {
        return None;
    }
    w.key.clear();
    w.key.extend(key.chars());
    w.name.clear();
    w.name.extend(st.name(it).chars());
    w.marks.clear();
    w.missed.clear();
    let mut score = 0;
    for (i, t) in terms.iter().enumerate() {
        match score_term(&t.chars, &w.key, &w.name, &mut w.marks) {
            Some(s) => score += s,
            None => w.missed.push(i),
        }
    }
    if w.missed.len() == terms.len() {
        return None;
    }
    // a term that isn't in the name can be in the folders above it: "invoice 2024"
    if !w.missed.is_empty() {
        let at: String = st.dir(it).chars().map(fold).collect();
        for &i in &w.missed {
            if !at.contains(&terms[i].text) {
                return None;
            }
            score += 100;
        }
    }
    // the same match: your own files before caches, nearer the top and shorter names first
    Some(score * 16 - if it.flags & NOISE != 0 { 4000 } else { 0 } - it.depth as i32 * 8 - w.name.len() as i32)
}

fn search(ix: &Arc<Index>, query: &str, hidden: bool, ticket: u64) -> Option<Found> {
    let terms: Vec<Term> = query
        .split_whitespace()
        .map(|t| {
            let text: String = t.chars().map(fold).collect();
            Term { chars: text.chars().collect(), must: text.trim_start_matches('*').as_bytes().to_vec(), text }
        })
        .collect();
    let st = ix.store.read();
    let items = &st.items;
    let done = ix.done.load(Ordering::Relaxed);
    if terms.is_empty() {
        return Some(Found { hits: Vec::new(), total: 0, indexed: items.len(), done });
    }
    // one more letter on the last word: only the last matches can still match (not after "*": "*.pd" ⊅ "*.pdf")
    let narrowed: Option<Vec<usize>> = LAST.lock().as_ref().and_then(|l| {
        let same = l.ix.upgrade().is_some_and(|x| Arc::ptr_eq(&x, ix)) && l.hidden == hidden;
        let longer = query.len() > l.query.len() && query.starts_with(&l.query) && !query[l.query.len()..].contains(char::is_whitespace);
        let star = query.split_whitespace().last().is_some_and(|t| t.starts_with('*'));
        // the same query again (the walk found more): the old matches plus the new items
        let narrower = query == l.query || (longer && !star && !l.query.ends_with(char::is_whitespace));
        (same && narrower).then(|| l.matched.iter().copied().chain(l.indexed..items.len()).collect())
    });
    let count = narrowed.as_ref().map_or(items.len(), Vec::len);
    let pick = |j: usize| narrowed.as_ref().map_or(j, |v| v[j]);
    // every core takes a slice
    let parts = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
    let chunk = count.div_ceil(parts).max(4096);
    let mut found: Vec<(i32, usize)> = std::thread::scope(|s| {
        let jobs: Vec<_> = (0..count)
            .step_by(chunk)
            .map(|from| {
                let (terms, st, pick) = (&terms, &*st, &pick);
                s.spawn(move || {
                    let mut w = Scratch::default();
                    let mut out = Vec::new();
                    for j in from..(from + chunk).min(count) {
                        if j % 4096 == 0 && TICKET.load(Ordering::Relaxed) != ticket {
                            return None;
                        }
                        let i = pick(j);
                        if let Some(sc) = rank(terms, st, &st.items[i], hidden, &mut w) {
                            out.push((sc, i));
                        }
                    }
                    Some(out)
                })
            })
            .collect();
        let mut all = Vec::new();
        for j in jobs {
            all.extend(j.join().ok()??);
        }
        Some(all)
    })?;
    *LAST.lock() = Some(Last { ix: Arc::downgrade(ix), query: query.to_owned(), hidden, indexed: items.len(), matched: found.iter().map(|f| f.1).collect() });
    let total = found.len();
    let better = |a: &(i32, usize), b: &(i32, usize)| b.0.cmp(&a.0).then_with(|| st.key(&items[a.1]).cmp(st.key(&items[b.1])));
    if found.len() > TOP {
        found.select_nth_unstable_by(TOP, better);
        found.truncate(TOP);
    }
    found.sort_unstable_by(better);
    let root_len = if ix.root.is_empty() { 0 } else { ix.root.trim_end_matches(['\\', '/']).len() + 1 };
    let mut w = Scratch::default();
    let hits = found
        .into_iter()
        .map(|(_, i)| {
            let it = &items[i];
            rank(&terms, &st, it, hidden, &mut w);
            let (dir, name) = (st.dir(it), st.name(it));
            let at = dir.trim_end_matches(['\\', '/']);
            Hit {
                name: name.to_owned(),
                path: if dir.ends_with(['\\', '/']) { format!("{dir}{name}") } else { format!("{dir}{MAIN_SEPARATOR}{name}") },
                is_dir: it.flags & DIR != 0,
                size: it.size,
                modified: it.modified,
                hidden: it.flags & HIDDEN != 0,
                at: at.get(root_len..).unwrap_or("").to_owned(),
                marks: w.marks.clone(),
            }
        })
        .collect();
    Some(Found { hits, total, indexed: items.len(), done })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(term: &str, name: &str) -> Option<(i32, Vec<u32>)> {
        let mut marks = Vec::new();
        let t: Vec<char> = term.chars().map(fold).collect();
        let n: Vec<char> = name.chars().collect();
        let k: Vec<char> = name.chars().map(fold).collect();
        score_term(&t, &k, &n, &mut marks).map(|s| (s, marks))
    }

    #[test]
    fn ranks_and_marks() {
        assert_eq!(score("readme", "README.md"), Some((900, vec![0, 6])));
        assert_eq!(score("tai lieu".split(' ').next().unwrap(), "Tài liệu.docx").map(|x| x.0), Some(800));
        assert_eq!(score("lieu", "Tài liệu.docx"), Some((600, vec![4, 8])));
        assert_eq!(score("fe", "FileExplorer.tsx"), Some((230, vec![0, 1, 4, 5])));
        assert_eq!(score("fiex", "FileExplorer.tsx"), Some((230, vec![0, 2, 4, 6])));
        assert_eq!(score("plor", "FileExplorer.tsx"), Some((400, vec![6, 10])));
        assert_eq!(score("*.pdf", "a.PDF"), Some((300, vec![1, 5])));
        assert_eq!(score("xyz", "FileExplorer.tsx"), None);
        assert_eq!(score("fl", "FileExplorer.tsx"), None);
        assert_eq!(score("lieu", "-l-i-b-r-a-r-y_-e-l-e-m-e-n-t-s.html"), None);
    }
}
