import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FilePlus2,
  FileSpreadsheet,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Image as ImageIcon,
  Monitor,
  Music,
  PanelRight,
  Paperclip,
  Pencil,
  RotateCw,
  Search,
  Trash2,
  Video,
  X,
  FileText
} from 'lucide-react'
import type { ExEntry, ExFound, ExHit, ExPlace } from '../../../shared/types'
import { useStore } from '../store'
import { openBrowser, openFile, openInOffice, setPcRevealer } from '../actions'
import { IMAGE_RE, attachPaths, imagePreview } from '../attachments'
import { openMenu } from './ContextMenu'
import { FileIcon, FolderIcon } from './icons'
import { RenameInput, startRename, useRenaming } from './InlineRename'
import { SourceSwitch } from './SourceSwitch'
import './explorer.css'

/* ================================ paths ================================ */

/** '' is "This PC": the folders and drives page */
const THIS_PC = ''
const ROW = 28

const keyOf = (p: string): string => p.toLowerCase()
const isRoot = (p: string): boolean => /^[A-Za-z]:\\$/.test(p) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(p)

/** As Windows writes it: backslashes, "C:" → "C:\", no trailing backslash except on a drive. */
function norm(p: string): string {
  let s = p.trim().replace(/^"(.*)"$/, '$1').replace(/\//g, '\\')
  if (/^[A-Za-z]:$/.test(s)) return s.toUpperCase() + '\\'
  if (/^[A-Za-z]:\\/.test(s)) s = s[0].toUpperCase() + s.slice(1)
  s = s.replace(/(?<!^)\\{2,}/g, '\\')
  return isRoot(s) ? s : s.replace(/\\+$/, '')
}
function parentOf(p: string): string {
  if (!p || isRoot(p)) return THIS_PC
  const i = p.lastIndexOf('\\')
  if (i < 0) return THIS_PC
  const up = p.slice(0, i)
  return /^[A-Za-z]:$/.test(up) ? up + '\\' : up
}
const join = (dir: string, name: string): string => (dir.endsWith('\\') ? dir + name : dir + '\\' + name)
const nameOf = (p: string): string => (isRoot(p) ? p.replace(/\\$/, '') : (p.split('\\').pop() ?? p))
const extOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/* ================================ file kinds ================================ */

const OFFICE_RE = /\.(docx|xlsx|csv|pdf)$/i
const TEXT_RE =
  /\.(txt|md|markdown|log|json|jsonc|json5|js|jsx|mjs|cjs|ts|tsx|mts|cts|css|scss|sass|less|html?|xml|xaml|svg|ya?ml|toml|ini|cfg|conf|env|py|pyw|rb|go|rs|java|kt|kts|cs|vb|fs|c|cc|cpp|cxx|h|hh|hpp|php|sql|sh|bash|zsh|ps1|psm1|psd1|bat|cmd|gitignore|gitattributes|editorconfig|lock|csproj|vbproj|fsproj|sln|props|targets|config|resx|razor|cshtml|vue|svelte|astro|dart|swift|lua|r|pl|gradle|properties|tsv|srt|vtt|graphql|gql|proto|prisma|tf|hcl|nix|ex|exs|erl|clj|scala|groovy|m|mm|asm|cmake|mk|diff|patch|rst|tex|bib|csv)$/i
const TEXT_NAMES = /^(dockerfile|makefile|license|licence|readme|changelog|authors|contributing|procfile|gemfile|rakefile|\.env.*|\.[\w-]+rc)$/i
const isText = (name: string): boolean => TEXT_RE.test(name) || TEXT_NAMES.test(name)

const TYPE_NAMES: Record<string, string> = {
  docx: 'Word document',
  doc: 'Word 97-2003 document',
  xlsx: 'Excel worksheet',
  xls: 'Excel 97-2003 worksheet',
  pptx: 'PowerPoint presentation',
  pdf: 'PDF document',
  csv: 'CSV file',
  txt: 'Text document',
  md: 'Markdown',
  png: 'PNG image',
  jpg: 'JPEG image',
  jpeg: 'JPEG image',
  gif: 'GIF image',
  webp: 'WEBP image',
  svg: 'SVG image',
  ico: 'Icon',
  zip: 'Compressed (zipped) folder',
  rar: 'RAR archive',
  '7z': '7-Zip archive',
  exe: 'Application',
  msi: 'Windows Installer package',
  lnk: 'Shortcut',
  url: 'Internet shortcut',
  dll: 'Application extension',
  mp4: 'MP4 video',
  mp3: 'MP3 audio',
  json: 'JSON file',
  html: 'HTML document',
  js: 'JavaScript file',
  ts: 'TypeScript file',
  tsx: 'TypeScript JSX file',
  css: 'CSS file',
  py: 'Python file',
  cs: 'C# file',
  sql: 'SQL file',
  bat: 'Windows batch file',
  ps1: 'PowerShell script',
  log: 'Log file'
}
function typeName(e: ExEntry): string {
  if (e.isDir) return 'File folder'
  const ext = extOf(e.name)
  return TYPE_NAMES[ext] ?? (ext ? `${ext.toUpperCase()} file` : 'File')
}

const DATE = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const dateText = (ms: number): string => (ms ? DATE.format(ms) : '')
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} ${units[u]}`
}

function placeIcon(kind: ExPlace['kind'], size = 15): React.ReactNode {
  switch (kind) {
    case 'home':
      return <Home size={size} className="fx-ic home" />
    case 'desktop':
      return <Monitor size={size} className="fx-ic desktop" />
    case 'documents':
      return <FileText size={size} className="fx-ic docs" />
    case 'downloads':
      return <Download size={size} className="fx-ic downloads" />
    case 'pictures':
      return <ImageIcon size={size} className="fx-ic pictures" />
    case 'videos':
      return <Video size={size} className="fx-ic videos" />
    case 'music':
      return <Music size={size} className="fx-ic music" />
    default:
      return <HardDrive size={size} className="fx-ic drive" />
  }
}

/* ================================ small stores ================================ */

const LS = {
  get: (k: string): string | null => localStorage.getItem(k),
  set: (k: string, v: string): void => localStorage.setItem(k, v)
}

/** listings already seen: back / forward / up show them at once, then refresh in place */
const listings = new Map<string, ExEntry[]>()
function remember(dir: string, list: ExEntry[]): void {
  listings.delete(keyOf(dir))
  listings.set(keyOf(dir), list)
  if (listings.size > 60) listings.delete(listings.keys().next().value!)
}

type SortKey = 'name' | 'modified' | 'type' | 'size'
type Sort = { key: SortKey; dir: 1 | -1 }

function sortRows(list: ExEntry[], s: Sort): ExEntry[] {
  const by: Record<SortKey, (a: ExEntry, b: ExEntry) => number> = {
    name: (a, b) => COLLATOR.compare(a.name, b.name),
    modified: (a, b) => a.modified - b.modified,
    type: (a, b) => COLLATOR.compare(typeName(a), typeName(b)),
    size: (a, b) => a.size - b.size
  }
  const f = by[s.key]
  // folders stay above files whatever the order, like Windows
  return [...list].sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : f(a, b) * s.dir || COLLATOR.compare(a.name, b.name)))
}

/* ================================ the tab ================================ */

interface RowApi {
  down(e: ExEntry, ev: React.MouseEvent): void
  open(e: ExEntry): void
  menu(e: ExEntry, ev: React.MouseEvent): void
  rename(e: ExEntry, next: string): void
}

/**
 * This PC view of the Source code tab: browse any folder on the computer (not just the project), with an address bar
 * you can type or paste a path into, and a preview that reads text files and shows pictures.
 * Office files open in the Office tab, code and text in Source code, the rest in their Windows app.
 */
export function FileExplorerPane(): React.JSX.Element {
  const onScreen = useStore((s) => s.centerView === 'files')
  const sourceFolded = useStore((s) => s.sourceFolded)
  const projectRoot = useStore((s) => s.root)
  const activeChatId = useStore((s) => s.activeChatId)

  const [hist, setHist] = useState<{ list: string[]; i: number }>(() => ({ list: [LS.get('vibe.fx.path') ?? THIS_PC], i: 0 }))
  const path = hist.list[hist.i]
  const [entries, setEntries] = useState<ExEntry[] | null>(() => listings.get(keyOf(path)) ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [places, setPlaces] = useState<ExPlace[]>([])
  const [sort, setSortState] = useState<Sort>(() => {
    try {
      return JSON.parse(LS.get('vibe.fx.sort') ?? '') as Sort
    } catch {
      return { key: 'name', dir: 1 }
    }
  })
  const [showHidden, setShowHidden] = useState(() => LS.get('vibe.fx.hidden') === '1')
  const [showPreview, setShowPreview] = useState(() => LS.get('vibe.fx.preview') !== '0')
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [editAddress, setEditAddress] = useState(false)
  const renaming = useRenaming((s) => s.key)

  /* ---------- loading ---------- */
  const loadSeq = useRef(0)
  /** after the next listing: select this path (and start renaming it) */
  const pending = useRef<{ select?: string; rename?: boolean } | null>(null)

  const load = useCallback(async (dir: string, quiet = false): Promise<void> => {
    const n = ++loadSeq.current
    if (dir === THIS_PC) {
      setEntries(null)
      setError('')
      setLoading(false)
      return
    }
    const seen = listings.get(keyOf(dir))
    if (seen) setEntries(seen)
    else if (!quiet) {
      setEntries(null)
      setLoading(true)
    }
    try {
      const list = await window.api.fs.explore(dir)
      if (n !== loadSeq.current) return
      remember(dir, list)
      setEntries(list)
      setError('')
    } catch (err) {
      if (n !== loadSeq.current) return
      setEntries([])
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      if (n === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(path)
    LS.set('vibe.fx.path', path)
  }, [path, load])

  const loadPlaces = useCallback(() => void window.api.fs.places().then(setPlaces, () => {}), [])
  useEffect(loadPlaces, [loadPlaces])

  // things change while you're elsewhere: refresh when the tab or the window comes back
  useEffect(() => {
    if (!onScreen) return
    void load(path, true)
    if (path === THIS_PC) loadPlaces()
    const again = (): void => {
      void load(path, true)
      if (path === THIS_PC) loadPlaces()
    }
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen])

  /* ---------- navigation ---------- */
  const scrollPos = useRef(new Map<string, number>())
  const go = useCallback(
    (to: string, select?: string): void => {
      const target = to === THIS_PC ? THIS_PC : norm(to)
      if (listRef.current) scrollPos.current.set(keyOf(path), listRef.current.scrollTop)
      pending.current = select ? { select } : null
      if (keyOf(target) === keyOf(path)) {
        void load(path, true)
        return
      }
      setHist((h) => ({ list: [...h.list.slice(0, h.i + 1), target], i: h.i + 1 }))
    },
    [path, load]
  )
  const step = (d: 1 | -1): void => {
    if (listRef.current) scrollPos.current.set(keyOf(path), listRef.current.scrollTop)
    // going up / back: the folder we came from is selected again
    pending.current = d === -1 ? { select: path } : null
    setHist((h) => ({ ...h, i: Math.max(0, Math.min(h.list.length - 1, h.i + d)) }))
  }
  const up = (): void => {
    if (path !== THIS_PC) go(parentOf(path), path)
  }
  // a path shown from elsewhere (a terminal link, a "Reveal" menu): its folder, the file selected
  useEffect(
    () =>
      setPcRevealer((p, isDir) => {
        const to = norm(p)
        setQuery('')
        if (isDir) go(to)
        else go(parentOf(to), to)
      }),
    [go]
  )
  const canBack = hist.i > 0
  const canFwd = hist.i < hist.list.length - 1

  // a new folder: fresh selection and search, the scroll position it had
  useLayoutEffect(() => {
    setQuery('')
    setSel(new Set())
    setFocus(null)
    anchor.current = null
    const el = listRef.current
    if (el) el.scrollTop = scrollPos.current.get(keyOf(path)) ?? 0
  }, [path])

  /* ---------- search: this folder and every folder below it (all drives from This PC) ---------- */
  const q = query.trim()
  const searching = !!q
  const [found, setFound] = useState<ExFound | null>(null)
  /** results best-first until a column header is clicked */
  const [byRank, setByRank] = useState(true)
  const [walked, setWalked] = useState(0)
  const searchSeq = useRef(0)
  /** a new search: an index older than a moment is walked again */
  const fresh = useRef(true)
  useEffect(() => {
    const n = ++searchSeq.current
    if (!q) {
      setFound(null)
      setByRank(true)
      fresh.current = true
      return
    }
    // one or two letters match half the disk: wait to see if another comes
    const t = window.setTimeout(
      () => {
        void window.api.fs.search(path, q, showHidden, fresh.current).then((f) => n === searchSeq.current && setFound(f), () => {})
        fresh.current = false
      },
      q.length < 3 ? 120 : 0
    )
    return () => window.clearTimeout(t)
  }, [q, path, showHidden, walked])
  // the walk found more: the same search again (only the new items get looked at)
  useEffect(() => {
    if (!searching) return
    return window.api.fs.onSearchProgress((p) => keyOf(p.root) === keyOf(path) && setWalked((w) => w + 1))
  }, [searching, path])
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [q])

  /* ---------- rows ---------- */
  const rows = useMemo((): ExEntry[] => {
    if (searching) return byRank ? (found?.hits ?? []) : sortRows(found?.hits ?? [], sort)
    let list = entries ?? []
    if (!showHidden) list = list.filter((e) => !e.hidden)
    return sortRows(list, sort)
  }, [entries, showHidden, searching, found, byRank, sort])
  const index = useMemo(() => new Map(rows.map((e, i) => [keyOf(e.path), i])), [rows])

  // select / rename what a navigation or a change asked for, once it's listed
  useEffect(() => {
    const p = pending.current
    if (!p?.select || !entries) return
    const i = index.get(keyOf(p.select))
    if (i === undefined) return
    pending.current = null
    const e = rows[i]
    setSel(new Set([e.path]))
    setFocus(e.path)
    anchor.current = e.path
    revealRow(i)
    if (p.rename) requestAnimationFrame(() => startRename('fx:' + e.path))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, index])

  const setSort = (key: SortKey): void => {
    if (searching && byRank) {
      // the first click on a header leaves best-first for that column, in its usual direction
      setByRank(false)
      if (sort.key === key) return
    }
    const next: Sort = sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'modified' || key === 'size' ? -1 : 1 }
    setSortState(next)
    LS.set('vibe.fx.sort', JSON.stringify(next))
  }

  /* ---------- virtual list ---------- */
  const [view, setView] = useState({ top: 0, h: 600 })
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setView((v) => (v.h === el.clientHeight ? v : { ...v, h: el.clientHeight })))
    ro.observe(el)
    setView({ top: el.scrollTop, h: el.clientHeight })
    return () => ro.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path === THIS_PC && !searching])
  const frame = useRef(0)
  const onScroll = (): void => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = listRef.current
      if (el) setView((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }))
    })
  }
  const first = Math.max(0, Math.floor(view.top / ROW) - 8)
  const last = Math.min(rows.length, Math.ceil((view.top + view.h) / ROW) + 8)

  function revealRow(i: number): void {
    const el = listRef.current
    if (!el) return
    const top = i * ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight
  }

  /* ---------- opening ---------- */
  const flash = (text: string): void => {
    setNote(text)
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(''), 4000)
  }
  const noteTimer = useRef(0)

  const openExternally = (p: string): void =>
    void window.api.fs.openPath(p).then((err) => err && flash(`Couldn't open ${nameOf(p)}: ${err}`))
  const openEntry = (e: ExEntry): void => {
    if (e.isDir) return go(e.path)
    if (OFFICE_RE.test(e.name)) return openInOffice(e.path)
    if (isText(e.name) || IMAGE_RE.test(e.name)) return openFile(e.path)
    openExternally(e.path)
  }

  /* ---------- changes ---------- */
  const refresh = (): void => {
    void load(path, true)
    if (path === THIS_PC) loadPlaces()
    // a search on screen walks the folders again, so renamed and deleted items show as they are now
    if (searching) void window.api.fs.searchForget().then(() => setWalked((w) => w + 1))
  }
  const selected = (): ExEntry[] => rows.filter((e) => sel.has(e.path))
  const remove = async (list: ExEntry[]): Promise<void> => {
    if (!list.length) return
    const what = list.length === 1 ? `"${list[0].name}"` : `these ${list.length} items`
    if (!(await window.api.ask(`Move ${what} to the Recycle Bin?`))) return
    for (const e of list) {
      await window.api.fs.trash(e.path).catch((err: unknown) => flash(`Couldn't delete ${e.name}: ${String(err)}`))
    }
    refresh()
  }
  const create = async (dir: boolean): Promise<void> => {
    if (path === THIS_PC) return
    const taken = new Set((entries ?? []).map((e) => e.name.toLowerCase()))
    const base = dir ? 'New folder' : 'New text document'
    const ext = dir ? '' : '.txt'
    let name = base + ext
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`
    const p = join(path, name)
    try {
      await window.api.fs.create(p, dir)
      pending.current = { select: p, rename: true }
      refresh()
    } catch (err) {
      flash(String(err))
    }
  }
  const rename = async (e: ExEntry, next: string): Promise<void> => {
    if (/[\\/:*?"<>|]/.test(next)) return flash('A name can\'t contain any of these characters: \\ / : * ? " < > |')
    const to = join(parentOf(e.path), next)
    try {
      await window.api.fs.rename(e.path, to)
      pending.current = { select: to }
      refresh()
    } catch (err) {
      flash(String(err))
    }
  }
  const copyText = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text)
    flash(`${what} copied`)
  }
  const attach = (paths: string[]): void => {
    if (!activeChatId) return
    void attachPaths(activeChatId, paths)
    flash(paths.length === 1 ? `${nameOf(paths[0])} will go with your next message` : `${paths.length} files will go with your next message`)
  }

  /* ---------- mouse ---------- */
  const rowMenu = (e: ExEntry, ev: React.MouseEvent): void => {
    let list = selected()
    if (!sel.has(e.path)) {
      setSel(new Set([e.path]))
      setFocus(e.path)
      anchor.current = e.path
      list = [e]
    }
    const many = list.length > 1
    openMenu(ev, [
      !many && { label: e.isDir ? 'Open' : 'Open', icon: <FolderOpen size={14} />, hint: 'Enter', action: () => openEntry(e) },
      !many && !e.isDir && OFFICE_RE.test(e.name) && { label: 'Open in Office tab', icon: <FileSpreadsheet size={14} />, action: () => openInOffice(e.path) },
      !many && !e.isDir && { label: 'Open in Source code', icon: <FileCode2 size={14} />, action: () => openFile(e.path) },
      !many && { label: 'Open with Windows app', icon: <ExternalLink size={14} />, action: () => openExternally(e.path) },
      !many && { label: 'Show in Windows Explorer', icon: <FolderOpen size={14} />, action: () => window.api.fs.reveal(e.path) },
      'sep',
      !!activeChatId && { label: many ? `Attach ${list.length} items to chat` : 'Attach to chat', icon: <Paperclip size={14} />, action: () => attach(list.map((x) => x.path)) },
      { label: many ? 'Copy paths' : 'Copy path', icon: <Copy size={14} />, hint: 'Ctrl+C', action: () => copyText(list.map((x) => x.path).join('\n'), many ? 'Paths' : 'Path') },
      !many && { label: 'Copy name', action: () => copyText(e.name, 'Name') },
      'sep',
      !many && { label: 'Rename', icon: <Pencil size={14} />, hint: 'F2', action: () => startRename('fx:' + e.path) },
      { label: 'Delete', icon: <Trash2 size={14} />, hint: 'Del', action: () => void remove(list) }
    ])
  }
  const backgroundMenu = (ev: React.MouseEvent): void => {
    if (path === THIS_PC) return
    setSel(new Set())
    openMenu(ev, [
      { label: 'New folder', icon: <FolderPlus size={14} />, action: () => void create(true) },
      { label: 'New text document', icon: <FilePlus2 size={14} />, action: () => void create(false) },
      'sep',
      { label: 'Refresh', icon: <RotateCw size={14} />, hint: 'F5', action: refresh },
      { label: showHidden ? 'Hide hidden items' : 'Show hidden items', icon: showHidden ? <EyeOff size={14} /> : <Eye size={14} />, action: () => toggleHidden() },
      'sep',
      { label: 'Copy folder path', icon: <Copy size={14} />, action: () => copyText(path, 'Path') },
      { label: 'Open in Windows Explorer', icon: <ExternalLink size={14} />, action: () => openExternally(path) },
      !!activeChatId && { label: 'Attach this folder to chat', icon: <Paperclip size={14} />, action: () => attach([path]) }
    ])
  }

  const api = useRef<RowApi>(null!)
  api.current = {
    down(e, ev) {
      listRef.current?.focus({ preventScroll: true })
      if (ev.button === 2 && sel.has(e.path)) return
      if (ev.shiftKey && anchor.current) {
        const a = index.get(keyOf(anchor.current)) ?? 0
        const b = index.get(keyOf(e.path)) ?? 0
        const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path)
        setSel(new Set(ev.ctrlKey ? [...sel, ...range] : range))
      } else if (ev.ctrlKey) {
        const next = new Set(sel)
        if (next.has(e.path)) next.delete(e.path)
        else next.add(e.path)
        setSel(next)
        anchor.current = e.path
      } else {
        setSel(new Set([e.path]))
        anchor.current = e.path
      }
      setFocus(e.path)
    },
    open: (e) => openEntry(e),
    menu: (e, ev) => rowMenu(e, ev),
    rename: (e, next) => void rename(e, next)
  }
  const rowApi = useMemo(
    () => ({
      down: (e: ExEntry, ev: React.MouseEvent) => api.current.down(e, ev),
      open: (e: ExEntry) => api.current.open(e),
      menu: (e: ExEntry, ev: React.MouseEvent) => api.current.menu(e, ev),
      rename: (e: ExEntry, next: string) => api.current.rename(e, next)
    }),
    []
  )

  const toggleHidden = (): void => {
    setShowHidden((v) => {
      LS.set('vibe.fx.hidden', v ? '0' : '1')
      return !v
    })
  }
  const togglePreview = (): void => {
    setShowPreview((v) => {
      LS.set('vibe.fx.preview', v ? '0' : '1')
      return !v
    })
  }

  /* ---------- keyboard ---------- */
  const typed = useRef({ text: '', at: 0 })
  const moveTo = (i: number, extend: boolean): void => {
    if (!rows.length) return
    const k = Math.max(0, Math.min(rows.length - 1, i))
    const e = rows[k]
    if (extend && anchor.current) {
      const a = index.get(keyOf(anchor.current)) ?? k
      setSel(new Set(rows.slice(Math.min(a, k), Math.max(a, k) + 1).map((x) => x.path)))
    } else {
      setSel(new Set([e.path]))
      anchor.current = e.path
    }
    setFocus(e.path)
    revealRow(k)
  }
  const onListKey = (e: React.KeyboardEvent): void => {
    const cur = focus ? (index.get(keyOf(focus)) ?? -1) : -1
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 300) / ROW) - 1)
    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.altKey) return
    switch (e.key) {
      case 'ArrowDown':
        handled()
        return moveTo(cur + 1, e.shiftKey)
      case 'ArrowUp':
        handled()
        return moveTo(cur < 0 ? 0 : cur - 1, e.shiftKey)
      case 'PageDown':
        handled()
        return moveTo(cur + page, e.shiftKey)
      case 'PageUp':
        handled()
        return moveTo(cur - page, e.shiftKey)
      case 'Home':
        handled()
        return moveTo(0, e.shiftKey)
      case 'End':
        handled()
        return moveTo(rows.length - 1, e.shiftKey)
      case 'Enter': {
        handled()
        const list = selected()
        if (list.length === 1) openEntry(list[0])
        else list.filter((x) => !x.isDir).forEach(openEntry)
        return
      }
      case 'Backspace':
        handled()
        return up()
      case 'F2':
        handled()
        if (focus) startRename('fx:' + focus)
        return
      case 'Delete':
        handled()
        void remove(selected())
        return
      case 'Escape':
        if (sel.size) {
          handled()
          setSel(new Set())
        }
        return
    }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      handled()
      setSel(new Set(rows.map((x) => x.path)))
      return
    }
    // (Ctrl+Shift+C / Ctrl+Shift+N are the app's own shortcuts: plain Ctrl+C copies the paths here)
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && sel.size) {
      handled()
      copyText(selected().map((x) => x.path).join('\n'), sel.size > 1 ? 'Paths' : 'Path')
      return
    }
    // typing a name jumps to it, like Windows
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && rows.length) {
      handled()
      const now = Date.now()
      const t = typed.current
      t.text = now - t.at > 800 ? e.key.toLowerCase() : t.text + e.key.toLowerCase()
      t.at = now
      const same = t.text.length > 1 && [...t.text].every((c) => c === t.text[0])
      const prefix = same ? t.text[0] : t.text
      const from = t.text.length === 1 || same ? cur + 1 : Math.max(0, cur)
      for (let n = 0; n < rows.length; n++) {
        const i = (from + n) % rows.length
        if (rows[i].name.toLowerCase().startsWith(prefix)) return moveTo(i, false)
      }
    }
  }
  /** keys that work anywhere in the tab */
  const onPaneKey = (e: React.KeyboardEvent): void => {
    const k = e.key
    const inField = (e.target as HTMLElement).closest('input, textarea')
    if (e.altKey && k === 'ArrowLeft') return void (e.preventDefault(), canBack && step(-1))
    if (e.altKey && k === 'ArrowRight') return void (e.preventDefault(), canFwd && step(1))
    if (e.altKey && k === 'ArrowUp') return void (e.preventDefault(), up())
    if (k === 'F5' || (e.ctrlKey && k.toLowerCase() === 'r')) return void (e.preventDefault(), refresh())
    if (inField) return
    if ((e.ctrlKey && k.toLowerCase() === 'l') || (e.altKey && k.toLowerCase() === 'd') || k === 'F4') {
      e.preventDefault()
      setEditAddress(true)
    } else if ((e.ctrlKey && k.toLowerCase() === 'f') || (e.ctrlKey && k.toLowerCase() === 'e') || k === 'F3') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }

  /* ---------- typed address ---------- */
  const home = places.find((p) => p.kind === 'home')?.path
  /** what was typed in the address bar → where to go; an error to show when it leads nowhere */
  const goTyped = async (raw: string): Promise<string | null> => {
    let t = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!t || /^(this pc|my computer|computer)$/i.test(t)) return go(THIS_PC), null
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) {
      openBrowser(/^www\./i.test(t) ? 'https://' + t : t)
      return null
    }
    if (/^file:\/\//i.test(t)) t = decodeURIComponent(t.replace(/^file:\/\/\/?/i, ''))
    // Windows' shell names: desktop, downloads…
    const named = places.find((p) => p.kind !== 'drive' && p.name.toLowerCase() === t.toLowerCase())
    if (named) return go(named.path), null
    if (home) t = t.replace(/^~(?=$|[\\/])/, home).replace(/%(userprofile|home)%/gi, home)
    if (projectRoot) t = t.replace(/^\$project(?=$|[\\/])/i, projectRoot)
    // relative to the folder on screen
    if (!/^([A-Za-z]:|\\\\|[\\/])/.test(t)) {
      if (path === THIS_PC) return `Windows can't find "${raw.trim()}". Type a full path, like C:\\Users`
      t = join(path, t)
    }
    const p = norm(t)
    const [info] = await window.api.app.fileInfo([p]).catch(() => [undefined])
    if (!info || (info.size < 0 && !info.dir)) return `Windows can't find "${raw.trim()}". Check the spelling and try again.`
    if (info.dir) go(p)
    else go(parentOf(p), p)
    return null
  }

  /* ---------- render ---------- */
  const focusEntry = focus ? rows[index.get(keyOf(focus)) ?? -1] : undefined
  const previewEntry = sel.size === 1 ? (focusEntry && sel.has(focusEntry.path) ? focusEntry : selected()[0]) : undefined
  const selSize = useMemo(() => rows.reduce((n, e) => (sel.has(e.path) && !e.isDir ? n + e.size : n), 0), [rows, sel])
  const placeFor = (p: string): ExPlace | undefined => places.find((x) => keyOf(x.path) === keyOf(p))

  return (
    <div
      className="fx"
      onKeyDown={onPaneKey}
      onMouseDown={(e) => {
        if (e.button === 3 || e.button === 4) e.preventDefault()
      }}
      onMouseUp={(e) => {
        if (e.button === 3 && canBack) step(-1)
        if (e.button === 4 && canFwd) step(1)
      }}
    >
      <nav className={`fx-nav${sourceFolded ? ' folded' : ''}`}>
        <SourceSwitch />
        <div className="fx-places">
          <button className={`fx-place${path === THIS_PC ? ' on' : ''}`} onClick={() => go(THIS_PC)}>
            <Monitor size={15} className="fx-ic pc" />
            <span>This PC</span>
          </button>
          {projectRoot && (
            <button className={`fx-place${keyOf(path) === keyOf(projectRoot) ? ' on' : ''}`} title={projectRoot} onClick={() => go(projectRoot)}>
              <FolderIcon open={false} size={15} />
              <span>{nameOf(projectRoot)}</span>
              <span className="fx-place-tag">project</span>
            </button>
          )}
          <div className="fx-nav-head">Quick access</div>
          {places
            .filter((p) => p.kind !== 'drive')
            .map((p) => (
              <button key={p.path} className={`fx-place${keyOf(path) === keyOf(p.path) ? ' on' : ''}`} title={p.path} onClick={() => go(p.path)}>
                {placeIcon(p.kind)}
                <span>{p.name}</span>
              </button>
            ))}
          <div className="fx-nav-head">Drives</div>
          {places
            .filter((p) => p.kind === 'drive')
            .map((p) => (
              <button key={p.path} className={`fx-place${keyOf(path) === keyOf(p.path) ? ' on' : ''}`} title={p.total ? `${sizeText(p.free)} free of ${sizeText(p.total)}` : p.path} onClick={() => go(p.path)}>
                {placeIcon(p.kind)}
                <span>{p.name}</span>
              </button>
            ))}
        </div>
      </nav>

      <div className="fx-right">
      <div className="fx-bar">
        <button className="icon-btn" title="Back (Alt+Left)" disabled={!canBack} onClick={() => step(-1)}>
          <ArrowLeft size={15} />
        </button>
        <button className="icon-btn" title="Forward (Alt+Right)" disabled={!canFwd} onClick={() => step(1)}>
          <ArrowRight size={15} />
        </button>
        <button className="icon-btn" title="Up to the parent folder (Alt+Up)" disabled={path === THIS_PC} onClick={up}>
          <ArrowUp size={15} />
        </button>
        <button className="icon-btn" title="Refresh (F5)" onClick={refresh}>
          <RotateCw size={14} className={loading ? 'fx-spin' : ''} />
        </button>
        <AddressBar
          path={path}
          places={places}
          editing={editAddress}
          setEditing={setEditAddress}
          onNavigate={(p) => go(p)}
          onSubmit={goTyped}
        />
        <div className="fx-search">
          <Search size={13} />
          <input
            ref={searchRef}
            value={query}
            spellCheck={false}
            placeholder={path === THIS_PC ? 'Search This PC' : `Search ${nameOf(path)}`}
            title="Searches every folder below this one. Accents and case don't matter; fe finds FileExplorer, *.pdf finds PDFs, a second word can be a folder name."
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setQuery('')
                listRef.current?.focus()
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault()
                listRef.current?.focus()
                if (rows.length) moveTo(0, false)
              }
            }}
          />
          {query && (
            <button className="fx-search-x" title="Clear" onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
        <button className={`icon-btn${showHidden ? ' on' : ''}`} title={showHidden ? 'Hide hidden items' : 'Show hidden items'} onClick={toggleHidden}>
          {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button className={`icon-btn${showPreview ? ' on' : ''}`} title={showPreview ? 'Hide the preview pane' : 'Show the preview pane'} onClick={togglePreview}>
          <PanelRight size={15} />
        </button>
      </div>

      <div className="fx-body">
        <div className="fx-main">
          {path === THIS_PC && !searching ? (
            <ThisPc places={places} onOpen={(p) => go(p)} />
          ) : (
            <>
              <div className="fx-head">
                {(
                  [
                    ['name', 'Name'],
                    ['modified', 'Date modified'],
                    ['type', 'Type'],
                    ['size', 'Size']
                  ] as [SortKey, string][]
                ).map(([k, label]) => (
                  <button key={k} className={`fx-col fx-col-${k}${sort.key === k ? ' on' : ''}`} onClick={() => setSort(k)}>
                    <span>{label}</span>
                    {sort.key === k && !(searching && byRank) && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>
                ))}
              </div>
              <div
                className="fx-list"
                ref={listRef}
                tabIndex={0}
                onScroll={onScroll}
                onKeyDown={onListKey}
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('fx-spacer')) {
                    if (!e.ctrlKey && !e.shiftKey) setSel(new Set())
                  }
                }}
                onContextMenu={backgroundMenu}
              >
                <div className="fx-spacer" style={{ height: rows.length * ROW }}>
                  {rows.slice(first, last).map((e, k) => (
                    <Row
                      key={e.path}
                      e={e}
                      top={(first + k) * ROW}
                      selected={sel.has(e.path)}
                      focused={focus === e.path}
                      renaming={renaming === 'fx:' + e.path}
                      api={rowApi}
                    />
                  ))}
                </div>
                {!rows.length && (searching ? found : !loading && entries) && (
                  <div className="fx-empty">
                    {searching ? (
                      <span>{found?.done ? `No items match "${q}"` : 'Searching…'}</span>
                    ) : error ? (
                      <>
                        <b>Can't open this folder</b>
                        <span>{error}</span>
                        <button className="btn btn-sm btn-ghost" onClick={up}>
                          <ArrowUp size={13} /> Go up
                        </button>
                      </>
                    ) : (
                      <span>This folder is empty.</span>
                    )}
                  </div>
                )}
                {loading && !entries && (
                  <div className="fx-loading">
                    {Array.from({ length: 8 }, (_, i) => (
                      <div key={i} className="fx-skel" style={{ animationDelay: `${i * 40}ms` }} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="fx-status">
            {path === THIS_PC && !searching ? (
              <span>{places.length} items</span>
            ) : (
              <>
                {searching ? (
                  <span>
                    {found ? `${found.total.toLocaleString()} ${found.total === 1 ? 'result' : 'results'}` : 'Searching…'}
                    {found && found.total > found.hits.length ? ` · best ${found.hits.length.toLocaleString()} shown` : ''}
                  </span>
                ) : (
                  <span>
                    {rows.length.toLocaleString()} {rows.length === 1 ? 'item' : 'items'}
                  </span>
                )}
                {searching && found && !found.done && (
                  <span className="fx-status-dim">
                    <RotateCw size={11} className="fx-spin" /> looking through {found.indexed.toLocaleString()} items…
                  </span>
                )}
                {sel.size > 0 && (
                  <span>
                    {sel.size.toLocaleString()} selected{selSize > 0 ? ` · ${sizeText(selSize)}` : ''}
                  </span>
                )}
                {!searching && !showHidden && entries && entries.some((e) => e.hidden) && <span className="fx-status-dim">hidden items not shown</span>}
              </>
            )}
            {note && <span className="fx-note">{note}</span>}
          </div>
        </div>

        {showPreview && (
          <Preview
            entry={previewEntry}
            folder={path === THIS_PC ? undefined : (placeFor(path)?.name ?? nameOf(path))}
            count={sel.size > 1 ? sel.size : rows.length}
            many={sel.size > 1}
            canAttach={!!activeChatId}
            onOpen={openEntry}
            onExternal={openExternally}
            onAttach={(p) => attach([p])}
            onCopy={(p) => copyText(p, 'Path')}
          />
        )}
      </div>
      </div>
    </div>
  )
}

/* ================================ a row ================================ */

const Row = memo(function Row({
  e,
  top,
  selected,
  focused,
  renaming,
  api
}: {
  e: ExEntry
  top: number
  selected: boolean
  focused: boolean
  renaming: boolean
  api: RowApi
}): React.JSX.Element {
  return (
    <div
      className={`fx-row${selected ? ' sel' : ''}${focused ? ' focus' : ''}${e.hidden ? ' hidden' : ''}`}
      style={{ transform: `translateY(${top}px)` }}
      title={e.path}
      onMouseDown={(ev) => {
        if (ev.button === 0 || ev.button === 2) api.down(e, ev)
      }}
      onDoubleClick={() => api.open(e)}
      onContextMenu={(ev) => api.menu(e, ev)}
    >
      <span className="fx-col-name">
        {e.isDir ? <FolderIcon open={false} size={16} /> : <FileIcon name={e.name} size={16} />}
        {renaming ? (
          <RenameInput value={e.name} stem={!e.isDir} onCommit={(next) => api.rename(e, next)} className="fx-rename" />
        ) : 'marks' in e ? (
          <>
            <span className="fx-name">{marked(e.name, (e as ExHit).marks)}</span>
            {(e as ExHit).at && <span className="fx-at">{(e as ExHit).at}</span>}
          </>
        ) : (
          <span className="fx-name">{e.name}</span>
        )}
      </span>
      <span className="fx-col-modified">{dateText(e.modified)}</span>
      <span className="fx-col-type">{typeName(e)}</span>
      <span className="fx-col-size">{e.isDir ? '' : sizeText(e.size)}</span>
    </div>
  )
})

/** the name with the letters the search matched in bold (marks: [start, end) pairs of characters, maybe overlapping) */
function marked(name: string, marks: number[]): React.ReactNode {
  const chars = Array.from(name)
  const on = new Array<boolean>(chars.length).fill(false)
  for (let i = 0; i + 1 < marks.length; i += 2) for (let c = marks[i]; c < marks[i + 1] && c < chars.length; c++) on[c] = true
  const out: React.ReactNode[] = []
  let from = 0
  for (let c = 1; c <= chars.length; c++) {
    if (c < chars.length && on[c] === on[from]) continue
    const text = chars.slice(from, c).join('')
    out.push(on[from] ? <mark key={from}>{text}</mark> : text)
    from = c
  }
  return out
}

/* ================================ address bar ================================ */

interface Sugg {
  path: string
  name: string
  isDir: boolean
}

function AddressBar({
  path,
  places,
  editing,
  setEditing,
  onNavigate,
  onSubmit
}: {
  path: string
  places: ExPlace[]
  editing: boolean
  setEditing: (v: boolean) => void
  onNavigate: (p: string) => void
  onSubmit: (text: string) => Promise<string | null>
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [sugg, setSugg] = useState<Sugg[]>([])
  const [pick, setPick] = useState(-1)
  const [err, setErr] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const crumbsRef = useRef<HTMLDivElement>(null)
  const typedSeq = useRef(0)

  // into edit mode: the whole path, selected, like Windows
  useLayoutEffect(() => {
    if (!editing) return
    setText(path)
    setSugg([])
    setPick(-1)
    setErr('')
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.select()
    })
  }, [editing, path])

  // a long path: keep its end (the folder you're in) in view
  useLayoutEffect(() => {
    const el = crumbsRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [path, editing, places])

  const suggest = (v: string): void => {
    const n = ++typedSeq.current
    const t = v.replace(/\//g, '\\')
    const cut = t.lastIndexOf('\\')
    if (cut < 0) {
      // no folder yet: drives and known folders by name
      const q = t.trim().toLowerCase()
      const list = q ? places.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().startsWith(q)) : []
      setSugg(list.slice(0, 8).map((p) => ({ path: p.path, name: p.name, isDir: true })))
      setPick(-1)
      return
    }
    const dir = norm(t.slice(0, cut + 1))
    const prefix = t.slice(cut + 1).toLowerCase()
    const show = (list: ExEntry[]): void => {
      if (n !== typedSeq.current) return
      const hits = list
        .filter((e) => !e.hidden && e.name.toLowerCase().startsWith(prefix))
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : COLLATOR.compare(a.name, b.name)))
        .slice(0, 10)
      setSugg(hits.map((e) => ({ path: e.path, name: e.name, isDir: e.isDir })))
      setPick(-1)
    }
    const seen = listings.get(keyOf(dir))
    if (seen) show(seen)
    else
      void window.api.fs.explore(dir).then(
        (list) => {
          remember(dir, list)
          show(list)
        },
        () => n === typedSeq.current && setSugg([])
      )
  }

  const submit = async (value: string): Promise<void> => {
    const problem = await onSubmit(value)
    if (problem) {
      setErr(problem)
      input.current?.select()
      return
    }
    setEditing(false)
  }
  /** Tab: take the suggestion into the box and keep typing from there */
  const complete = (s: Sugg): void => {
    const v = s.isDir ? (s.path.endsWith('\\') ? s.path : s.path + '\\') : s.path
    setText(v)
    suggest(v)
  }

  const crumbs = useMemo(() => {
    if (path === THIS_PC) return []
    const out: { label: string; path: string }[] = []
    const unc = path.match(/^(\\\\[^\\]+\\[^\\]+)/)
    let rest: string
    if (unc) {
      out.push({ label: unc[1], path: unc[1] })
      rest = path.slice(unc[1].length)
    } else {
      const drive = path.slice(0, 3)
      const place = places.find((p) => p.kind === 'drive' && keyOf(p.path) === keyOf(drive))
      out.push({ label: place?.name ?? drive.replace(/\\$/, ''), path: drive })
      rest = path.slice(3)
    }
    let acc = out[0].path
    for (const part of rest.split('\\').filter(Boolean)) {
      acc = join(acc, part)
      out.push({ label: part, path: acc })
    }
    return out
  }, [path, places])

  if (editing) {
    return (
      <div className={`fx-address editing${err ? ' bad' : ''}`}>
        <input
          ref={input}
          value={text}
          spellCheck={false}
          placeholder="Type a path (C:\Users…), a folder name, or a web address"
          onChange={(e) => {
            setText(e.target.value)
            setErr('')
            suggest(e.target.value)
          }}
          onBlur={() => setTimeout(() => setEditing(false), 120)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit(pick >= 0 && sugg[pick] ? sugg[pick].path : text)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              if (sugg.length) setSugg([])
              else setEditing(false)
            } else if (e.key === 'Tab' && sugg.length) {
              e.preventDefault()
              complete(sugg[pick >= 0 ? pick : 0])
            } else if (e.key === 'ArrowDown' && sugg.length) {
              e.preventDefault()
              setPick((i) => (i + 1) % sugg.length)
            } else if (e.key === 'ArrowUp' && sugg.length) {
              e.preventDefault()
              setPick((i) => (i <= 0 ? sugg.length - 1 : i - 1))
            }
          }}
        />
        {err && <div className="fx-address-err">{err}</div>}
        {!err && sugg.length > 0 && (
          <div className="fx-sugg">
            {sugg.map((s, i) => (
              <button
                key={s.path}
                className={i === pick ? 'on' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setPick(i)}
                onClick={() => void submit(s.path)}
              >
                {s.isDir ? <FolderIcon open={false} size={14} /> : <FileIcon name={s.name} size={14} />}
                <span className="fx-sugg-name">{s.name}</span>
                <span className="fx-sugg-path">{s.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="fx-address" title="Click to type a path" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), setEditing(true))}>
      <div className="fx-crumbs" ref={crumbsRef} onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), setEditing(true))}>
        <button className="fx-crumb" onClick={() => onNavigate(THIS_PC)}>
          <Monitor size={13} />
          {path === THIS_PC && <span>This PC</span>}
        </button>
        {crumbs.map((c, i) => (
          <span key={c.path} className="fx-crumb-wrap">
            <ChevronRight size={12} className="fx-crumb-sep" />
            <button className={`fx-crumb${i === crumbs.length - 1 ? ' last' : ''}`} onClick={() => onNavigate(c.path)}>
              {c.label}
            </button>
          </span>
        ))}
      </div>
      <div className="fx-address-fill" onMouseDown={(e) => (e.preventDefault(), setEditing(true))} />
    </div>
  )
}

/* ================================ This PC ================================ */

function ThisPc({ places, onOpen }: { places: ExPlace[]; onOpen: (p: string) => void }): React.JSX.Element {
  const folders = places.filter((p) => p.kind !== 'drive')
  const drives = places.filter((p) => p.kind === 'drive')
  return (
    <div className="fx-pc">
      <div className="fx-pc-head">Folders</div>
      <div className="fx-pc-grid">
        {folders.map((p) => (
          <button key={p.path} className="fx-card" title={p.path} onClick={() => onOpen(p.path)}>
            <span className="fx-card-ic">{placeIcon(p.kind, 22)}</span>
            <span className="fx-card-text">
              <b>{p.name}</b>
              <span>{p.path}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="fx-pc-head">Devices and drives</div>
      <div className="fx-pc-grid">
        {drives.map((p) => {
          const used = p.total ? 1 - p.free / p.total : 0
          return (
            <button key={p.path} className="fx-card" onClick={() => onOpen(p.path)}>
              <span className="fx-card-ic">{placeIcon(p.kind, 24)}</span>
              <span className="fx-card-text">
                <b>{p.name}</b>
                {p.total > 0 && (
                  <>
                    <span className="fx-meter">
                      <span className={used > 0.9 ? 'full' : ''} style={{ width: `${Math.round(used * 100)}%` }} />
                    </span>
                    <span>
                      {sizeText(p.free)} free of {sizeText(p.total)}
                    </span>
                  </>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ================================ preview ================================ */

type Shown =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'image'; src: string }
  | { kind: 'text'; text: string; cut: boolean }
  | { kind: 'binary' }
  | { kind: 'big' }

const TEXT_SHOW = 200_000

function Preview({
  entry,
  folder,
  count,
  many,
  canAttach,
  onOpen,
  onExternal,
  onAttach,
  onCopy
}: {
  entry: ExEntry | undefined
  folder: string | undefined
  count: number
  many: boolean
  canAttach: boolean
  onOpen: (e: ExEntry) => void
  onExternal: (p: string) => void
  onAttach: (p: string) => void
  onCopy: (p: string) => void
}): React.JSX.Element {
  const [shown, setShown] = useState<Shown>({ kind: 'none' })
  const [dims, setDims] = useState('')
  const key = entry ? `${entry.path}|${entry.modified}|${entry.size}` : ''

  useEffect(() => {
    setDims('')
    if (!entry || entry.isDir) return setShown({ kind: 'none' })
    let live = true
    // arrowing through a folder: only the row you stop on is read
    const t = setTimeout(() => {
      if (IMAGE_RE.test(entry.name)) {
        void imagePreview(entry.path).then((src) => live && setShown(src ? { kind: 'image', src } : { kind: 'binary' }))
      } else if (OFFICE_RE.test(entry.name) && !/\.csv$/i.test(entry.name)) {
        setShown({ kind: 'none' })
      } else if (entry.size > 4 * 1024 * 1024) {
        setShown({ kind: 'big' })
      } else if (isText(entry.name) || entry.size < 512 * 1024) {
        void window.api.fs.readFile(entry.path).then(
          (r) => {
            if (!live) return
            if (r.binary) setShown({ kind: 'binary' })
            else if (r.tooLarge) setShown({ kind: 'big' })
            else setShown({ kind: 'text', text: r.content.slice(0, TEXT_SHOW), cut: r.content.length > TEXT_SHOW })
          },
          () => live && setShown({ kind: 'binary' })
        )
      } else setShown({ kind: 'binary' })
    }, 70)
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!entry) {
    return (
      <aside className="fx-preview">
        <div className="fx-preview-empty">
          <FolderOpen size={34} strokeWidth={1.4} />
          <b>{many ? `${count.toLocaleString()} items selected` : (folder ?? 'This PC')}</b>
          <span>{many ? 'Right-click for what you can do with them.' : 'Select a file to read it here. Double-click opens it.'}</span>
        </div>
      </aside>
    )
  }

  const office = !entry.isDir && OFFICE_RE.test(entry.name)
  return (
    <aside className="fx-preview">
      <div className="fx-preview-head">
        <span className="fx-preview-ic">{entry.isDir ? <FolderIcon open={false} size={26} /> : <FileIcon name={entry.name} size={26} />}</span>
        <div className="fx-preview-title">
          <b title={entry.name}>{entry.name}</b>
          <span>
            {typeName(entry)}
            {!entry.isDir && ` · ${sizeText(entry.size)}`}
            {dims && ` · ${dims}`}
          </span>
          <span>Modified {dateText(entry.modified)}</span>
        </div>
      </div>
      <div className="fx-preview-actions">
        <button className="btn btn-sm btn-primary" onClick={() => onOpen(entry)}>
          {entry.isDir ? 'Open folder' : office ? 'Open in Office' : 'Open'}
        </button>
        {!entry.isDir && (
          <button className="icon-btn" title="Open with its Windows app" onClick={() => onExternal(entry.path)}>
            <ExternalLink size={14} />
          </button>
        )}
        <button className="icon-btn" title="Copy path" onClick={() => onCopy(entry.path)}>
          <Copy size={14} />
        </button>
        {canAttach && (
          <button className="icon-btn" title="Attach to chat" onClick={() => onAttach(entry.path)}>
            <Paperclip size={14} />
          </button>
        )}
      </div>
      <div className="fx-preview-body">
        {shown.kind === 'loading' && <div className="fx-preview-wait" />}
        {shown.kind === 'image' && (
          <div className="fx-preview-img">
            <img src={shown.src} alt="" draggable={false} onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
          </div>
        )}
        {shown.kind === 'text' && (
          <pre className="fx-preview-text">
            {shown.text || <span className="fx-dim">(empty file)</span>}
            {shown.cut && <span className="fx-dim">{'\n\n'}… open it to read the rest</span>}
          </pre>
        )}
        {(shown.kind === 'binary' || shown.kind === 'big' || (shown.kind === 'none' && !entry.isDir)) && (
          <div className="fx-preview-none">
            {office ? (
              <span>Opens in the Office tab, where you can read and edit it.</span>
            ) : shown.kind === 'big' ? (
              <span>Too large to preview here.</span>
            ) : (
              <span>No preview for this kind of file.</span>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
