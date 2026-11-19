import { app, type BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { existsSync, promises as fsp, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ZaloIncoming, ZaloTask, ZaloTasksState } from '../shared/types'
import { cleanEnv, detectClaude } from './pty'
import * as zalo from './zalo'
import { initToasts, showToasts, type ToastCard } from './zaloToast'

/**
 * "Việc của tôi": Claude reads what was sent to me on Zalo (personal chats, @mentions, replies to me)
 * and keeps a checklist — not answered = todo, answered but not finished = doing, reported done = done.
 */

const WINDOW_DAYS = 7
const KEEP_DONE_DAYS = 14
/** after a message to me: if nothing more arrives for this long, send the batch to Claude */
const REALTIME_DELAY = 30_000
const MODEL = 'haiku'

let getWin: () => BrowserWindow | null = () => null
let tasks: ZaloTask[] = []
let analyzedAt = 0
let running = false
let error: string | undefined
let loaded = false
let again = false
let autoTimer: NodeJS.Timeout | null = null
/** when the waiting batch goes to Claude */
let dueAt = 0
/** messages to me waiting to become tasks (shown as progress) */
let incoming: ZaloIncoming[] = []
/** tasks created by the last analysis */
let fresh: string[] = []
/** tasks whose status the last analysis changed */
let changed: string[] = []
/** tasks created / changed by Claude that I haven't looked at yet (the badge on the Zalo tab) */
let unseen: Record<string, 'new' | 'updated'> = {}
/** the Zalo tab is on screen in a focused window: changes count as seen right away, no pop-up */
let viewing = false

const dir = (): string => join(app.getPath('userData'), 'zalo')
const file = (): string => join(dir(), 'tasks.json')

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const d = JSON.parse(readFileSync(file(), 'utf8'))
    tasks = Array.isArray(d.tasks) ? d.tasks : []
    analyzedAt = Number(d.analyzedAt) || 0
    unseen = d.unseen && typeof d.unseen === 'object' ? d.unseen : {}
  } catch {
    /* first run */
  }
}

async function save(): Promise<void> {
  await fsp.mkdir(dir(), { recursive: true })
  await fsp.writeFile(file(), JSON.stringify({ tasks, analyzedAt, unseen }))
}

export function getTasks(): ZaloTasksState {
  load()
  const withAvatar = tasks.map((t) => {
    const uid = t.fromId ?? (t.group ? undefined : t.threadId)
    return { ...t, avatar: uid ? zalo.avatarOf(uid) : undefined }
  })
  return { tasks: withAvatar, running, analyzedAt, error, incoming, fresh, changed, unseen, dueAt: autoTimer ? dueAt : undefined }
}

function broadcast(): void {
  getWin()?.webContents.send('zalo:tasks', getTasks())
}

export function initZaloTasks(win: () => BrowserWindow | null): void {
  getWin = win
  initToasts(() => {
    const w = getWin()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    w.webContents.send('zalo:showTasks')
  })
  // realtime: a new message to me (or my reply in a chat with open work) → analyze within seconds
  zalo.onIngest((ids) => {
    load()
    const since = Math.max(analyzedAt, Date.now() - 10 * 60_000)
    const feed = zalo.workFeed(Date.now() - WINDOW_DAYS * 86_400_000).filter((t) => ids.includes(t.threadId))
    let relevant = false
    for (const t of feed) {
      for (const m of t.msgs) {
        if (m.ts <= since) continue
        if (m.toMe) {
          relevant = true
          if (!incoming.some((x) => x.msgId === m.id))
            incoming.push({
              threadId: t.threadId,
              msgId: m.id,
              threadName: t.name,
              group: t.group,
              from: m.from,
              avatar: zalo.avatarOf(m.fromId),
              text: m.text.slice(0, 160),
              ts: m.ts
            })
        } else if (m.self && tasks.some((x) => x.threadId === t.threadId && x.status !== 'done')) relevant = true
      }
    }
    if (!relevant) return
    // each new message restarts the wait: the batch goes once the chat is quiet for REALTIME_DELAY
    if (autoTimer) clearTimeout(autoTimer)
    dueAt = Date.now() + REALTIME_DELAY
    autoTimer = setTimeout(() => {
      autoTimer = null
      void analyze()
    }, REALTIME_DELAY)
    broadcast()
  })
}

const STATUS_TAG: Record<ZaloTask['status'], { text: string; color: string }> = {
  todo: { text: 'Cần làm', color: '#e5484d' },
  doing: { text: 'Đang xử lý', color: '#d9922e' },
  done: { text: 'Hoàn thành', color: '#2f9e63' }
}

/** Badge + Zalo-style pop-ups for tasks Claude just created or changed. */
function announce(created: ZaloTask[], updated: ZaloTask[]): void {
  const w = getWin()
  const looking = viewing && !!w && w.isVisible() && w.isFocused()
  if (looking) return
  for (const t of created) unseen[t.id] = 'new'
  for (const t of updated) if (unseen[t.id] !== 'new') unseen[t.id] = 'updated'
  const card = (t: ZaloTask, kind: 'new' | 'updated'): ToastCard => {
    const uid = t.fromId ?? (t.group ? undefined : t.threadId)
    return {
      id: t.id,
      name: t.from,
      avatar: uid ? zalo.avatarOf(uid) : undefined,
      title: t.from,
      tag: kind === 'new' ? { text: 'Việc mới', color: '#3b82f6' } : STATUS_TAG[t.status],
      body: t.title,
      meta: t.group ? t.threadName : undefined
    }
  }
  const cards = [...created.map((t) => card(t, 'new')), ...updated.map((t) => card(t, 'updated'))]
  if (!cards.length) return
  void showToasts(cards)
  if (w && !w.isFocused()) w.flashFrame(true)
}

/** The Zalo tab is (not) on screen; while it is, everything counts as seen. */
export function setViewing(on: boolean): void {
  viewing = on
  if (on) markSeen()
}

export function markSeen(): void {
  load()
  if (!Object.keys(unseen).length) return
  unseen = {}
  void save()
  broadcast()
}

export function setStatus(id: string, status: ZaloTask['status']): ZaloTasksState {
  load()
  const t = tasks.find((x) => x.id === id)
  if (t) Object.assign(t, { status, manual: true, updatedAt: Date.now() })
  delete unseen[id]
  void save()
  broadcast()
  return getTasks()
}

/* ------------------------- context for a new chat ------------------------- */

const MAX_DOWNLOAD = 25 * 1024 * 1024
// eslint-disable-next-line no-control-regex
const safeName = (s: string): string => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file'

async function download(url: string, path: string): Promise<boolean> {
  try {
    const r = await fetch(url)
    if (!r.ok) return false
    const len = Number(r.headers.get('content-length'))
    if (len > MAX_DOWNLOAD) return false
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > MAX_DOWNLOAD) return false
    await fsp.writeFile(path, buf)
    return true
  } catch {
    return false
  }
}

const extOf = (url: string, fallback: string): string => {
  const m = /\.(png|jpe?g|gif|webp|bmp)(?:$|[?#])/i.exec(url)
  return m ? m[1].toLowerCase() : fallback
}

/**
 * Everything a coding chat needs about a task: the conversation around it written to a Markdown file,
 * with photos and files sent in that chat downloaded next to it. Returns the file's path.
 */
export async function taskContext(id: string): Promise<{ file: string; images: string[]; files: string[] }> {
  load()
  const t = tasks.find((x) => x.id === id)
  if (!t) throw new Error('Không tìm thấy việc này')
  const all = zalo.getMessages(t.threadId, 400).filter((m) => !m.recalled)
  let start = t.msgId ? all.findIndex((m) => m.id === t.msgId) : -1
  if (start < 0) start = all.findIndex((m) => m.ts >= t.ts)
  if (start < 0) start = Math.max(0, all.length - 30)
  // a little of what came before (the question often builds on it), then everything since, capped
  const msgs = all.slice(Math.max(0, start - 15)).slice(0, 120)
  const out = join(dir(), 'context', t.id)
  await fsp.rm(out, { recursive: true, force: true })
  await fsp.mkdir(out, { recursive: true })
  const images: string[] = []
  const files: string[] = []
  let n = 0
  const lines: string[] = []
  for (const m of msgs) {
    const who = m.self ? 'Tôi' : m.fromName
    const reply = m.reply ? ` _(trả lời ${m.reply.from}: "${m.reply.text.replace(/\s+/g, ' ').slice(0, 120)}")_` : ''
    let body = m.text.replace(/\r?\n/g, '\n  ')
    const a = m.att
    if (a && (a.kind === 'photo' || a.kind === 'gif') && (a.url || a.thumb)) {
      const url = a.url ?? a.thumb!
      const path = join(out, `img-${String(++n).padStart(2, '0')}.${extOf(url, 'jpg')}`)
      if (await download(url, path)) {
        images.push(path)
        body = `[ảnh] ${path}` + (a.desc ? ` — ${a.desc}` : '')
      }
    } else if (a?.kind === 'file' && a.url && (a.size ?? 0) <= MAX_DOWNLOAD) {
      const name = safeName(a.title ?? `file-${++n}${a.ext ? '.' + a.ext : ''}`)
      const path = join(out, name)
      if (await download(a.url, path)) {
        files.push(path)
        body = `[tệp] ${path}`
      }
    }
    lines.push(`- **${who}** (${fmt(m.ts)})${reply}${m.id === t.msgId ? ' ⟵ **yêu cầu**' : ''}: ${body}`)
  }
  const list = (title: string, paths: string[]): string => (paths.length ? `- ${title}:\n${paths.map((p) => `  - ${p}`).join('\n')}\n` : '')
  const md = `# Việc từ Zalo: ${t.title}

**Hướng dẫn cho bạn (Claude):** Đây là một việc tôi nhận qua Zalo. Hãy đọc kỹ đoạn chat bên dưới${images.length ? ' và XEM TẤT CẢ ảnh đính kèm (dùng Read với đường dẫn ảnh)' : ''}${files.length ? ', mở các tệp đính kèm' : ''}, rồi tìm hiểu code trong project hiện tại liên quan tới yêu cầu. Sau đó tóm tắt lại yêu cầu bằng tiếng Việt, nêu nguyên nhân / vị trí code liên quan và đề xuất cách xử lý. CHƯA sửa code cho tới khi tôi xác nhận.

- Người yêu cầu: ${t.from}${t.group ? ` (nhóm "${t.threadName}")` : ''}
- Thời gian: ${fmt(t.ts)}
- Tóm tắt: ${t.title}
${t.detail ? `- Ngữ cảnh: ${t.detail}\n` : ''}${list('Ảnh đính kèm', images)}${list('Tệp đính kèm', files)}
## Đoạn chat ${t.group ? `nhóm "${t.threadName}"` : `với ${t.threadName}`}

${lines.join('\n')}
`
  const file = join(out, 'context.md')
  await fsp.writeFile(file, md, 'utf8')
  return { file, images, files }
}

export function removeTask(id: string): ZaloTasksState {
  load()
  tasks = tasks.filter((x) => x.id !== id)
  delete unseen[id]
  void save()
  broadcast()
  return getTasks()
}

/* ------------------------------ Claude ------------------------------ */

function runClaude(prompt: string): Promise<string> {
  return detectClaude().then(
    (info) =>
      new Promise<string>((resolve, reject) => {
        let path = info.path
        if (!path) return reject(new Error('Không tìm thấy Claude Code trên máy'))
        // `where claude` lists npm's extensionless sh shim first; Windows needs the .cmd next to it
        if (process.platform === 'win32' && !/\.\w+$/.test(path) && existsSync(path + '.cmd')) path += '.cmd'
        const isCmd = /\.(cmd|bat)$/i.test(path)
        // no saved session (keeps the chat history clean), no MCP servers — it only needs to read the prompt
        const args = ['-p', '--output-format', 'json', '--model', MODEL, '--no-session-persistence', '--strict-mcp-config']
        const p = spawn(isCmd ? `"${path}"` : path, args, {
          cwd: dir(),
          env: cleanEnv(),
          shell: isCmd,
          windowsHide: true
        })
        let out = ''
        let err = ''
        const timer = setTimeout(() => {
          p.kill()
          reject(new Error('Claude phản hồi quá lâu'))
        }, 5 * 60_000)
        p.stdout.on('data', (d) => (out += d))
        p.stderr.on('data', (d) => (err += d))
        p.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
        p.on('close', (code) => {
          clearTimeout(timer)
          try {
            const j = JSON.parse(out)
            if (j.is_error) return reject(new Error(String(j.result || 'Claude báo lỗi')))
            resolve(String(j.result ?? ''))
          } catch {
            reject(new Error((err || out || `claude thoát với mã ${code}`).trim().slice(0, 300)))
          }
        })
        p.stdin.end(prompt, 'utf8')
      })
  )
}

const fmt = (ts: number): string => new Date(ts).toLocaleString('vi-VN', { hour12: false })

function buildPrompt(feed: zalo.WorkThread[], open: ZaloTask[]): string {
  const convo = feed
    .map((t) => {
      const lines = t.msgs.map((m) => `  [${m.id}] ${fmt(m.ts)} ${m.from}${m.toMe ? ' →TÔI' : ''}: ${m.text.replace(/\s+/g, ' ')}`)
      return `### threadId=${t.threadId} · ${t.group ? 'Nhóm' : 'Cá nhân'} "${t.name}"\n${lines.join('\n')}`
    })
    .join('\n\n')
  const existing = open.map((t) => ({ id: t.id, threadId: t.threadId, title: t.title, status: t.status }))
  return `Bạn là trợ lý quản lý công việc. Dưới đây là tin nhắn Zalo gửi tới TÔI (chat cá nhân, nhóm @nhắc tên tôi hoặc trả lời tin của tôi) trong ${WINDOW_DAYS} ngày qua, kèm các tin "Tôi" đã gửi sau đó. Dòng có "→TÔI" là tin gửi trực tiếp cho tôi.

Nhiệm vụ: lập danh sách CÔNG VIỆC của tôi — những yêu cầu, câu hỏi cần tôi trả lời, việc được giao/nhờ tôi làm. Bỏ qua chào hỏi, tán gẫu, quảng cáo, tin thông báo tự động, tin không cần tôi làm gì.

Trạng thái mỗi việc:
- "todo": tôi chưa trả lời / chưa phản hồi gì.
- "doing": tôi đã phản hồi nhưng chưa xong (vd "ok", "để em xem", "đang làm", hẹn sẽ gửi).
- "done": tôi đã báo xong / đã gửi / đã trả lời đầy đủ câu hỏi, hoặc người yêu cầu nói đã ổn / huỷ.

Việc đã có (giữ nguyên "id" nếu vẫn là việc đó, cập nhật status/title nếu cần; KHÔNG tạo trùng):
${JSON.stringify(existing)}

Tin nhắn:
${convo}

Chỉ trả về MỘT object JSON, không giải thích, dạng:
{"tasks":[{"id":"<id việc đã có hoặc null>","threadId":"...","msgId":"<id tin yêu cầu>","from":"<người giao>","title":"<việc cần làm, ngắn gọn, tiếng Việt>","detail":"<1 câu tóm tắt ngữ cảnh / tôi đã trả lời gì>","status":"todo|doing|done"}]}
Trả về đầy đủ mọi việc (cả việc đã có còn liên quan).`
}

interface RawTask {
  id?: string | null
  threadId?: string
  msgId?: string
  from?: string
  title?: string
  detail?: string
  status?: string
}

function parse(text: string): RawTask[] {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('Claude không trả về JSON')
  const j = JSON.parse(text.slice(a, b + 1))
  return Array.isArray(j.tasks) ? j.tasks : []
}

/** Read the last few days of messages to me and update the checklist. */
export async function analyze(): Promise<ZaloTasksState> {
  load()
  if (running) {
    again = true
    return getTasks()
  }
  if (zalo.getState().status !== 'online' && !zalo.selfId()) {
    error = 'Zalo chưa đăng nhập'
    broadcast()
    return getTasks()
  }
  running = true
  error = undefined
  // messages that arrive during this run stay "incoming" for the next one
  const handling = new Set(incoming.map((m) => m.msgId))
  const created: ZaloTask[] = []
  const updated: ZaloTask[] = []
  broadcast()
  try {
    const now = Date.now()
    const feed = zalo.workFeed(now - WINDOW_DAYS * 86_400_000)
    if (feed.length) {
      const known = new Set(feed.map((t) => t.threadId))
      const open = tasks.filter((t) => known.has(t.threadId))
      const raw = parse(await runClaude(buildPrompt(feed, open)))
      const byThread = new Map(feed.map((t) => [t.threadId, t]))
      for (const r of raw) {
        const th = r.threadId ? byThread.get(r.threadId) : undefined
        const title = r.title?.trim()
        if (!th || !title) continue
        const status: ZaloTask['status'] = r.status === 'done' || r.status === 'doing' ? r.status : 'todo'
        const src = th.msgs.find((m) => m.id === r.msgId)
        const cur = (r.id && tasks.find((t) => t.id === r.id)) || (r.msgId ? tasks.find((t) => t.threadId === th.threadId && t.msgId === r.msgId) : undefined)
        if (cur) {
          cur.title = title
          cur.detail = r.detail?.trim() || cur.detail
          cur.threadName = th.name
          if (!cur.fromId && src && !src.self) cur.fromId = src.fromId
          // a status set by hand stays, unless Claude now sees it finished
          if (!cur.manual || status === 'done') {
            if (cur.status !== status) {
              cur.updatedAt = now
              if (!updated.includes(cur)) updated.push(cur)
            }
            cur.status = status
            if (status === 'done') cur.manual = false
          }
        } else {
          const task: ZaloTask = {
            id: randomUUID(),
            title,
            detail: r.detail?.trim() || undefined,
            threadId: th.threadId,
            threadName: th.name,
            group: th.group,
            msgId: src?.id,
            from: r.from?.trim() || src?.from || th.name,
            fromId: src && !src.self ? src.fromId : th.group ? undefined : th.threadId,
            ts: src?.ts ?? th.msgs[th.msgs.length - 1].ts,
            status,
            updatedAt: now
          }
          tasks.push(task)
          created.push(task)
        }
      }
    }
    // forget finished work after a while
    const keep = now - KEEP_DONE_DAYS * 86_400_000
    tasks = tasks.filter((t) => t.status !== 'done' || t.updatedAt > keep)
    for (const id of Object.keys(unseen)) if (!tasks.some((t) => t.id === id)) delete unseen[id]
    tasks.sort((a, b) => b.ts - a.ts)
    analyzedAt = now
    fresh = created.map((t) => t.id)
    changed = updated.map((t) => t.id)
    announce(
      created.filter((t) => t.status !== 'done'),
      updated
    )
    await save()
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    running = false
    incoming = incoming.filter((m) => !handling.has(m.msgId))
    broadcast()
  }
  if (again) {
    again = false
    return analyze()
  }
  return getTasks()
}
