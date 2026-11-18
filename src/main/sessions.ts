import { promises as fsp, existsSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { WebContents } from 'electron'
import type { ProjectGroup, SessionInfo } from '../shared/types'

/**
 * Reads the Claude Code session store (~/.claude/projects/<encoded-cwd>/<session>.jsonl),
 * which the Claude desktop app, the CLI and the IDE extensions all share.
 * The JSONL format is internal to Claude Code, so everything here is best-effort:
 * we only pick out cwd, title and timestamps, and skip whatever we don't recognise.
 */

export const projectsDir = (): string => join(homedir(), '.claude', 'projects')

const cache = new Map<string, { mtime: number; info: SessionInfo | null }>()

async function readSlice(file: string, start: number, length: number): Promise<string> {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

function parseLines(text: string, dropFirst: boolean): Record<string, unknown>[] {
  const lines = text.split('\n')
  if (dropFirst) lines.shift() // probably cut mid-line
  const out: Record<string, unknown>[] = []
  for (const l of lines) {
    if (!l.startsWith('{')) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* partial line */
    }
  }
  return out
}

function userText(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'user') return null
  const msg = rec.message as { content?: unknown } | undefined
  let text: string | null = null
  if (typeof msg?.content === 'string') text = msg.content
  else if (Array.isArray(msg?.content)) {
    const t = msg!.content.find((c: { type?: string }) => c?.type === 'text') as { text?: string } | undefined
    text = t?.text ?? null
  }
  if (!text) return null
  text = text.trim()
  // skip injected command / system wrappers
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) return null
  return text.replace(/\s+/g, ' ')
}

function findTitle(recs: Record<string, unknown>[]): string | null {
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]
    if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) return r.customTitle.trim()
  }
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]
    if (r.type === 'summary' && typeof r.summary === 'string') return r.summary
  }
  return null
}

async function readSession(file: string, dirName: string): Promise<SessionInfo | null> {
  const st = await fsp.stat(file)
  const hit = cache.get(file)
  if (hit && hit.mtime === st.mtimeMs) return hit.info

  const HEAD = 96 * 1024
  const TAIL = 256 * 1024
  const head = parseLines(await readSlice(file, 0, Math.min(HEAD, st.size)), false)
  const tail = st.size > HEAD ? parseLines(await readSlice(file, Math.max(0, st.size - TAIL), Math.min(TAIL, st.size)), true) : []

  let cwd: string | null = null
  let firstPrompt: string | null = null
  let created: number | null = null
  for (const r of head) {
    if (!cwd && typeof r.cwd === 'string') cwd = r.cwd
    if (!created && typeof r.timestamp === 'string') created = Date.parse(r.timestamp) || null
    if (!firstPrompt) firstPrompt = userText(r)
    if (cwd && firstPrompt && created) break
  }
  let info: SessionInfo | null = null
  if (firstPrompt || findTitle(head)) {
    const title = findTitle(tail) ?? findTitle(head) ?? firstPrompt!.slice(0, 90)
    if (!cwd) cwd = decodeDirName(dirName)
    info = {
      id: basename(file, '.jsonl'),
      title,
      cwd,
      projectCwd: projectRoot(cwd),
      created: created ?? st.birthtimeMs,
      updated: st.mtimeMs,
      cwdExists: existsSync(cwd)
    }
  }
  cache.set(file, { mtime: st.mtimeMs, info })
  return info
}

/** Lossy fallback when no record carries a cwd: "E--softek-core2" → "E:\softek\core2". */
function decodeDirName(d: string): string {
  const m = d.match(/^([A-Za-z])--(.*)$/)
  return m ? `${m[1]}:\\${m[2].replace(/-/g, '\\')}` : d
}

/** Worktree sessions belong to the repo they were cut from. */
function projectRoot(cwd: string): string {
  const m = cwd.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/i)
  return m ? m[1] : cwd
}

export async function listSessions(): Promise<ProjectGroup[]> {
  const root = projectsDir()
  let dirs: string[]
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }

  const all: SessionInfo[] = []
  await Promise.all(
    dirs.map(async (d) => {
      let files: string[]
      try {
        files = (await fsp.readdir(join(root, d))).filter((f) => f.endsWith('.jsonl'))
      } catch {
        return
      }
      for (const f of files) {
        const info = await readSession(join(root, d, f), d).catch(() => null)
        if (info) all.push(info)
      }
    })
  )

  const groups = new Map<string, ProjectGroup>()
  for (const s of all) {
    const key = s.projectCwd.toLowerCase().replace(/[\\/]+$/, '')
    let g = groups.get(key)
    if (!g) {
      g = { key, cwd: s.projectCwd, name: basename(s.projectCwd) || s.projectCwd, updated: 0, sessions: [] }
      groups.set(key, g)
    }
    g.sessions.push(s)
    g.updated = Math.max(g.updated, s.updated)
  }
  const list = [...groups.values()]
  for (const g of list) g.sessions.sort((a, b) => b.updated - a.updated)
  // Two folders with the same name ("monk" in two places) → add the parent folder to tell them apart.
  const byName = new Map<string, ProjectGroup[]>()
  for (const g of list) byName.set(g.name.toLowerCase(), [...(byName.get(g.name.toLowerCase()) ?? []), g])
  for (const same of byName.values()) {
    if (same.length < 2) continue
    for (const g of same) {
      const parent = basename(dirname(g.cwd))
      if (parent) g.name = `${g.name} · ${parent}`
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  return list
}

let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

/** Push a "sessions changed" ping whenever Claude (any client) writes to the store. */
export function watchSessions(wc: WebContents): void {
  if (watcher) return
  watcher = chokidar.watch(projectsDir(), {
    ignoreInitial: true,
    depth: 1,
    ignored: (p: string, stats?: { isFile(): boolean }) => !!stats?.isFile() && !p.endsWith('.jsonl')
  })
  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!wc.isDestroyed()) wc.send('sessions:changed')
    }, 600)
  })
}

/* ---------------- images in a session ---------------- */

const IMG_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const MAX_IMAGES = 40
const MAX_FILE_BYTES = 8 * 1024 * 1024

async function findSessionFile(sessionId: string): Promise<string | null> {
  const root = projectsDir()
  let dirs: string[]
  try {
    dirs = await fsp.readdir(root)
  } catch {
    return null
  }
  for (const d of dirs) {
    const f = join(root, d, sessionId + '.jsonl')
    if (existsSync(f)) return f
  }
  return null
}

/**
 * Every image in a chat, oldest first: pictures pasted into the conversation, screenshots tools
 * returned, and image files named in the user's messages. Returned as data: URLs.
 */
export async function sessionImages(sessionId: string): Promise<string[]> {
  if (!/^[\w-]+$/.test(sessionId)) return []
  const file = await findSessionFile(sessionId)
  if (!file) return []
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return []
  }
  const found: Array<{ data?: string; path?: string }> = []
  const seen = new Set<string>()
  const add = (key: string, item: { data?: string; path?: string }): void => {
    if (seen.has(key)) return
    seen.add(key)
    found.push(item)
  }
  const walk = (blocks: unknown, fromUser: boolean): void => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'image') {
        const src = b.source as { type?: string; media_type?: string; data?: string } | undefined
        if (src?.type === 'base64' && src.data) {
          add(src.data.slice(0, 200) + src.data.length, { data: `data:${src.media_type ?? 'image/png'};base64,${src.data}` })
        }
      } else if (b.type === 'tool_result') {
        walk(b.content, false)
      } else if (b.type === 'text' && fromUser && typeof b.text === 'string') {
        for (const m of b.text.matchAll(/[A-Za-z]:[\/][^"'\n\r<>|*?]+?\.(?:png|jpe?g|gif|webp)\b/gi)) {
          add(m[0].toLowerCase(), { path: m[0] })
        }
      }
    }
  }
  for (const line of text.split('\n')) {
    if (!line.includes('image') && !/\.(png|jpe?g|gif|webp)/i.test(line)) continue
    try {
      const row = JSON.parse(line) as { type?: string; message?: { content?: unknown } }
      const content = row.message?.content
      if (typeof content === 'string') walk([{ type: 'text', text: content }], row.type === 'user')
      else walk(content, row.type === 'user')
    } catch {
      /* partial line while Claude is writing */
    }
  }
  const out: string[] = []
  for (const item of found.slice(-MAX_IMAGES)) {
    if (item.data) {
      out.push(item.data)
      continue
    }
    const p = item.path as string
    const mime = IMG_EXT[(p.split('.').pop() ?? '').toLowerCase()]
    try {
      const st = await fsp.stat(p)
      if (!mime || !st.isFile() || st.size > MAX_FILE_BYTES) continue
      out.push(`data:${mime};base64,${(await fsp.readFile(p)).toString('base64')}`)
    } catch {
      /* file is gone (e.g. temp paste cleaned up) */
    }
  }
  return out
}

/**
 * How full a chat's context window is: the token count of the last main-thread API call
 * (input + cache read + cache write + output), from the tail of the session file.
 */
export async function sessionContext(sessionId: string): Promise<{ used: number; model: string } | null> {
  if (!/^[\w-]+$/.test(sessionId)) return null
  const file = await findSessionFile(sessionId)
  if (!file) return null
  let size: number
  try {
    size = (await fsp.stat(file)).size
  } catch {
    return null
  }
  // widen the window until a usage line turns up (big tool results can push it far back)
  for (const span of [256 * 1024, 4 * 1024 * 1024, size]) {
    const start = Math.max(0, size - span)
    let rows: Record<string, unknown>[]
    try {
      rows = parseLines(await readSlice(file, start, size - start), start > 0)
    } catch {
      return null
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r.type !== 'assistant' || r.isSidechain || r.isApiErrorMessage) continue
      const msg = r.message as { model?: string; usage?: Record<string, number> } | undefined
      const u = msg?.usage
      if (!u || msg?.model === '<synthetic>') continue
      const used =
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
      if (used > 0) return { used, model: msg?.model ?? '' }
    }
    if (start === 0) break
  }
  return null
}
