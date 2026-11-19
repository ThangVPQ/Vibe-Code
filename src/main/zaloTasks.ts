import { app, type BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { existsSync, promises as fsp, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ZaloTask, ZaloTasksState } from '../shared/types'
import { cleanEnv, detectClaude } from './pty'
import * as zalo from './zalo'

/**
 * "Việc của tôi": Claude reads what was sent to me on Zalo (personal chats, @mentions, replies to me)
 * and keeps a checklist — not answered = todo, answered but not finished = doing, reported done = done.
 */

const WINDOW_DAYS = 7
const KEEP_DONE_DAYS = 14
const AUTO_DELAY = 90_000
const MODEL = 'haiku'

let getWin: () => BrowserWindow | null = () => null
let tasks: ZaloTask[] = []
let analyzedAt = 0
let running = false
let error: string | undefined
let loaded = false
let again = false
let autoTimer: NodeJS.Timeout | null = null

const dir = (): string => join(app.getPath('userData'), 'zalo')
const file = (): string => join(dir(), 'tasks.json')

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const d = JSON.parse(readFileSync(file(), 'utf8'))
    tasks = Array.isArray(d.tasks) ? d.tasks : []
    analyzedAt = Number(d.analyzedAt) || 0
  } catch {
    /* first run */
  }
}

async function save(): Promise<void> {
  await fsp.mkdir(dir(), { recursive: true })
  await fsp.writeFile(file(), JSON.stringify({ tasks, analyzedAt }))
}

export function getTasks(): ZaloTasksState {
  load()
  return { tasks, running, analyzedAt, error }
}

function broadcast(): void {
  getWin()?.webContents.send('zalo:tasks', getTasks())
}

export function initZaloTasks(win: () => BrowserWindow | null): void {
  getWin = win
  // new messages to me (or my replies) → re-check a little later, batched
  zalo.onIngest(() => {
    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      autoTimer = null
      void analyze()
    }, AUTO_DELAY)
  })
}

export function setStatus(id: string, status: ZaloTask['status']): ZaloTasksState {
  load()
  const t = tasks.find((x) => x.id === id)
  if (t) Object.assign(t, { status, manual: true, updatedAt: Date.now() })
  void save()
  broadcast()
  return getTasks()
}

export function removeTask(id: string): ZaloTasksState {
  load()
  tasks = tasks.filter((x) => x.id !== id)
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
          // a status set by hand stays, unless Claude now sees it finished
          if (!cur.manual || status === 'done') {
            if (cur.status !== status) cur.updatedAt = now
            cur.status = status
            if (status === 'done') cur.manual = false
          }
        } else {
          tasks.push({
            id: randomUUID(),
            title,
            detail: r.detail?.trim() || undefined,
            threadId: th.threadId,
            threadName: th.name,
            group: th.group,
            msgId: src?.id,
            from: r.from?.trim() || src?.from || th.name,
            ts: src?.ts ?? th.msgs[th.msgs.length - 1].ts,
            status,
            updatedAt: now
          })
        }
      }
    }
    // forget finished work after a while
    const keep = now - KEEP_DONE_DAYS * 86_400_000
    tasks = tasks.filter((t) => t.status !== 'done' || t.updatedAt > keep)
    tasks.sort((a, b) => b.ts - a.ts)
    analyzedAt = now
    await save()
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    running = false
    broadcast()
  }
  if (again) {
    again = false
    return analyze()
  }
  return getTasks()
}
