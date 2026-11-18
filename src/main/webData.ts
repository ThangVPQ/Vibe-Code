import { app } from 'electron'
import { copyFile, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { WebBookmark, WebData, WebSuggestion } from '../shared/types'

/*
 * Bookmarks and history for the Web tab, shared by every tab of every chat.
 * Imported once from all Chrome profiles; visits in the Web tab are added from then on.
 */

interface HistoryEntry {
  url: string
  title: string
  visits: number
  /** last visit, ms */
  last: number
}

const MAX_HISTORY = 20000
const file = (): string => join(app.getPath('userData'), 'web-data.json')
const chromeRoot = (): string => join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')

let loaded = false
let importedAt = 0
let bookmarks: WebBookmark[] = []
const history = new Map<string, HistoryEntry>()
let saveTimer: NodeJS.Timeout | null = null

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const d = JSON.parse(readFileSync(file(), 'utf8')) as { importedAt?: number; bookmarks?: WebBookmark[]; history?: HistoryEntry[] }
    importedAt = d.importedAt ?? 0
    bookmarks = d.bookmarks ?? []
    for (const h of d.history ?? []) history.set(h.url, h)
  } catch {
    /* nothing yet */
  }
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const list = [...history.values()].sort((a, b) => b.last - a.last).slice(0, MAX_HISTORY)
    void writeFile(file(), JSON.stringify({ importedAt, bookmarks, history: list }), 'utf8').catch(() => {})
  }, 1000)
}

export function getWebData(): WebData {
  load()
  return { importedAt, bookmarks, chromeFound: existsSync(join(chromeRoot(), 'Local State')) }
}

/* ---------------- Chrome import ---------------- */

interface ChromeNode {
  type: 'url' | 'folder'
  name: string
  url?: string
  children?: ChromeNode[]
}

const toBookmark = (n: ChromeNode): WebBookmark | null =>
  n.type === 'url' && n.url ? { title: n.name, url: n.url } : n.type === 'folder' ? { title: n.name, children: (n.children ?? []).map(toBookmark).filter((x): x is WebBookmark => !!x) } : null

/** Chrome profile folders, Default first */
function profiles(): string[] {
  try {
    const ls = JSON.parse(readFileSync(join(chromeRoot(), 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, unknown> } }
    return Object.keys(ls.profile?.info_cache ?? {}).sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true })))
  } catch {
    return ['Default']
  }
}

/** Bar items of every profile (deduplicated by URL); "other" and "mobile" bookmarks go in one folder at the end. */
async function importBookmarks(dirs: string[]): Promise<WebBookmark[]> {
  const bar: WebBookmark[] = []
  const other: WebBookmark[] = []
  const seen = new Set<string>()
  const add = (to: WebBookmark[], nodes: ChromeNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      if (n.type === 'url' && (!n.url || seen.has(n.url))) continue
      if (n.url) seen.add(n.url)
      const b = toBookmark(n)
      if (b && (b.url || b.children?.length)) to.push(b)
    }
  }
  for (const d of dirs)
    // signed-in profiles keep them in AccountBookmarks, local ones in Bookmarks
    for (const name of ['AccountBookmarks', 'Bookmarks']) {
      try {
        const roots = (JSON.parse(await readFile(join(chromeRoot(), d, name), 'utf8')) as { roots: Record<string, { children?: ChromeNode[] }> }).roots
        add(bar, roots.bookmark_bar?.children)
        add(other, roots.other?.children)
        add(other, roots.synced?.children)
      } catch {
        /* no such file */
      }
    }
  if (other.length) bar.push({ title: 'Other bookmarks', children: other })
  return bar
}

/** History of every profile, read from a copy (Chrome keeps the file open). */
async function importHistory(dirs: string[]): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const tmp = join(app.getPath('temp'), `vibe-chrome-history-${Date.now()}.db`)
  for (const d of dirs) {
    try {
      await copyFile(join(chromeRoot(), d, 'History'), tmp)
      const db = new DatabaseSync(tmp, { readOnly: true })
      try {
        // Chrome time is microseconds since 1601 (too big for a JS number): turned into ms since 1970 in SQL
        const rows = db
          .prepare(`SELECT url, title, visit_count AS visits, last_visit_time / 1000 - 11644473600000 AS last FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ${MAX_HISTORY}`)
          .all() as { url: string; title: string; visits: number; last: number }[]
        for (const r of rows) {
          if (!/^https?:/i.test(r.url)) continue
          const last = Number(r.last)
          const h = history.get(r.url)
          if (h) {
            h.visits += r.visits
            if (last > h.last) Object.assign(h, { last, title: r.title || h.title })
          } else history.set(r.url, { url: r.url, title: r.title, visits: r.visits, last })
        }
      } finally {
        db.close()
      }
    } catch {
      /* profile without history, or the copy failed */
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }
}

export async function importChrome(): Promise<WebData> {
  load()
  const dirs = profiles()
  bookmarks = await importBookmarks(dirs)
  await importHistory(dirs)
  importedAt = Date.now()
  await mkdir(app.getPath('userData'), { recursive: true })
  save()
  return getWebData()
}

/* ---------------- visits and suggestions ---------------- */

export function recordVisit(url: string, title = ''): void {
  if (!/^https?:/i.test(url)) return
  load()
  const h = history.get(url)
  if (h) Object.assign(h, { visits: h.visits + 1, last: Date.now(), title: title || h.title })
  else history.set(url, { url, title, visits: 1, last: Date.now() })
  save()
}

export function setVisitTitle(url: string, title: string): void {
  const h = history.get(url)
  if (h && title && h.title !== title) {
    h.title = title
    save()
  }
}

/** Address-bar suggestions: bookmarks and history whose URL or title contains every typed word. */
export function suggest(query: string, limit = 8): WebSuggestion[] {
  load()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const match = (url: string, title: string): boolean => {
    const s = (url + ' ' + title).toLowerCase()
    return words.every((w) => s.includes(w))
  }
  // every match, bookmarked or visited, ranked together
  const found = new Map<string, WebSuggestion & { visits: number; last: number }>()
  const walk = (list: WebBookmark[]): void => {
    for (const b of list) {
      if (b.children) walk(b.children)
      else if (b.url && match(b.url, b.title)) found.set(b.url, { url: b.url, title: b.title, bookmark: true, visits: 0, last: 0 })
    }
  }
  walk(bookmarks)
  for (const h of history.values()) {
    if (!match(h.url, h.title)) continue
    const f = found.get(h.url)
    if (f) Object.assign(f, { visits: h.visits, last: h.last })
    else found.set(h.url, { url: h.url, title: h.title, visits: h.visits, last: h.last })
  }
  const now = Date.now()
  // frequent, recent, bookmarked and short (site roots) first; a host typed from its start ranks highest
  const score = (x: { url: string; bookmark?: boolean; visits: number; last: number }): number => {
    const bare = x.url.replace(/^https?:\/\/(www\.)?/i, '').toLowerCase()
    const age = x.last ? (now - x.last) / (30 * 864e5) : 3
    return Math.log(1 + x.visits) - Math.min(age, 6) + (x.bookmark ? 2 : 0) + (bare.startsWith(words[0]) ? 5 : 0) - bare.length / 60
  }
  return [...found.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map(({ url, title, bookmark }) => ({ url, title, bookmark }))
}
