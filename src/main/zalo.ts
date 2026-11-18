import { app, safeStorage, type BrowserWindow } from 'electron'
import { promises as fsp, readFileSync } from 'fs'
import { join } from 'path'
import { LoginQRCallbackEventType, ThreadType, Zalo, type API, type Credentials, type Message } from 'zca-js'
import type { ZaloMessage, ZaloState, ZaloThread } from '../shared/types'

/**
 * Personal Zalo account through zca-js (unofficial: it talks to Zalo the way Zalo Web does).
 *
 * Login is a QR scan; the session (imei + cookies + user agent) is kept safeStorage-encrypted so
 * the next launch logs in by itself. Zalo has no "list my conversations with history" call for
 * 1-to-1 chats, so we keep our own cache: everything the listener receives (live messages and the
 * recent history Zalo replays on connect) lands in userData/zalo/cache.json.
 */

let getWin: () => BrowserWindow | null = () => null
let api: API | null = null
let state: ZaloState = { status: 'off' }
let abortQR: (() => unknown) | null = null

const dir = (): string => join(app.getPath('userData'), 'zalo')
const credFile = (): string => join(dir(), 'session.bin')
const cacheFile = (): string => join(dir(), 'cache.json')

/* ---------------- cache: threads, messages, names ---------------- */

const MAX_PER_THREAD = 3000
const threads = new Map<string, ZaloThread>()
const messages = new Map<string, ZaloMessage[]>()
/** userId → display name (friends, senders seen) */
const names = new Map<string, string>()
let cacheLoaded = false
let saveTimer: NodeJS.Timeout | null = null
let changedTimer: NodeJS.Timeout | null = null

function loadCache(): void {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const c = JSON.parse(readFileSync(cacheFile(), 'utf8')) as { threads: ZaloThread[]; messages: Record<string, ZaloMessage[]>; names: Record<string, string> }
    for (const t of c.threads ?? []) threads.set(t.id, t)
    for (const [k, v] of Object.entries(c.messages ?? {})) messages.set(k, v)
    for (const [k, v] of Object.entries(c.names ?? {})) names.set(k, v)
  } catch {
    /* no cache yet */
  }
}

function scheduleSave(): void {
  // tell the window soon, write the disk a little later
  if (!changedTimer)
    changedTimer = setTimeout(() => {
      changedTimer = null
      getWin()?.webContents.send('zalo:changed')
    }, 300)
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void writeCache()
  }, 3000)
}

async function writeCache(): Promise<void> {
  const data = { threads: [...threads.values()], messages: Object.fromEntries(messages), names: Object.fromEntries(names) }
  await fsp.mkdir(dir(), { recursive: true })
  await fsp.writeFile(cacheFile(), JSON.stringify(data), 'utf8').catch(() => {})
}

/** Readable text for any Zalo message: plain text as is, attachments as "[kind] title url". */
function contentText(msgType: string, content: unknown): string {
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return `[${msgType}]`
  const c = content as Record<string, unknown>
  const kind = msgType.replace(/^(chat|share)\./, '')
  const label: Record<string, string> = { photo: 'ảnh', video: 'video', voice: 'ghi âm', sticker: 'sticker', gif: 'gif', file: 'file', link: 'link', location: 'vị trí', recommended: 'danh thiếp' }
  const parts = [`[${label[kind] ?? kind}]`]
  for (const k of ['title', 'description', 'href']) {
    const v = c[k]
    if (typeof v === 'string' && v.trim() && !parts.includes(v)) parts.push(v.trim())
  }
  return parts.join(' ')
}

function ingest(list: Message[]): void {
  if (!list.length) return
  loadCache()
  for (const m of list) {
    const d = m.data
    const isGroup = m.type === ThreadType.Group
    const msg: ZaloMessage = {
      id: String(d.msgId),
      cliMsgId: String(d.cliMsgId),
      threadId: m.threadId,
      group: isGroup,
      fromId: m.isSelf ? state.self?.id ?? String(d.uidFrom) : String(d.uidFrom),
      fromName: m.isSelf ? 'Tôi' : d.dName || names.get(String(d.uidFrom)) || String(d.uidFrom),
      self: m.isSelf,
      ts: Number(d.ts) || Date.now(),
      type: d.msgType,
      text: contentText(d.msgType, d.content),
      quote: d.quote?.msg ? `${d.quote.fromD}: ${d.quote.msg}` : undefined
    }
    if (!m.isSelf && d.dName) names.set(msg.fromId, d.dName)
    const arr = messages.get(m.threadId) ?? []
    if (arr.some((x) => x.id === msg.id)) continue
    arr.push(msg)
    arr.sort((a, b) => a.ts - b.ts)
    if (arr.length > MAX_PER_THREAD) arr.splice(0, arr.length - MAX_PER_THREAD)
    messages.set(m.threadId, arr)
    const t = threads.get(m.threadId) ?? { id: m.threadId, group: isGroup, name: '', lastTs: 0, last: '' }
    if (!t.name && !isGroup && !m.isSelf && d.dName) t.name = d.dName
    if (!t.name) t.name = isGroup ? '' : names.get(m.threadId) ?? ''
    if (msg.ts >= t.lastTs) {
      t.lastTs = msg.ts
      t.last = `${msg.self ? 'Bạn' : msg.fromName}: ${msg.text}`.slice(0, 200)
    }
    threads.set(m.threadId, t)
  }
  scheduleSave()
}

/* ---------------- session ---------------- */

function setState(patch: Partial<ZaloState>): void {
  state = { ...state, ...patch }
  getWin()?.webContents.send('zalo:state', state)
}

async function saveCreds(c: Credentials): Promise<void> {
  const raw = JSON.stringify(c)
  const body = safeStorage.isEncryptionAvailable() ? Buffer.concat([Buffer.from('E1'), safeStorage.encryptString(raw)]) : Buffer.from('P1' + raw)
  await fsp.mkdir(dir(), { recursive: true })
  await fsp.writeFile(credFile(), body)
}

function readCreds(): Credentials | null {
  try {
    const b = readFileSync(credFile())
    const tag = b.subarray(0, 2).toString()
    const raw = tag === 'E1' ? safeStorage.decryptString(b.subarray(2)) : b.subarray(2).toString('utf8')
    return JSON.parse(raw) as Credentials
  } catch {
    return null
  }
}

const newZalo = (): Zalo => new Zalo({ selfListen: true, checkUpdate: false, logging: false })

const OLD_PAGES = 15
async function afterLogin(a: API): Promise<void> {
  api = a
  loadCache()
  const id = a.getOwnId()
  setState({ status: 'online', qr: undefined, error: undefined, self: { id, name: state.self?.name ?? '', avatar: state.self?.avatar ?? '' } })
  a.fetchAccountInfo()
    .then((r) => setState({ self: { id, name: r.profile.displayName || r.profile.zaloName, avatar: r.profile.avatar } }))
    .catch(() => {})
  void loadNames(a)

  // recent history: Zalo replays it page by page over the socket
  const pages = { [ThreadType.User]: 0, [ThreadType.Group]: 0 }
  const l = a.listener
  l.on('connected', () => {
    pages[ThreadType.User] = pages[ThreadType.Group] = 0
    l.requestOldMessages(ThreadType.User)
    l.requestOldMessages(ThreadType.Group)
  })
  l.on('message', (m) => ingest([m]))
  l.on('old_messages', (list, type) => {
    ingest(list)
    if (list.length && ++pages[type] < OLD_PAGES) {
      const oldest = list.reduce((a, b) => (Number(a.data.ts) <= Number(b.data.ts) ? a : b))
      l.requestOldMessages(type, oldest.data.msgId)
    }
  })
  l.on('closed', (code) => {
    if (api !== a) return
    // 3000: the account opened Zalo Web somewhere else — only one web session may listen
    setState({ status: 'error', error: code === 3000 ? 'Zalo Web đang mở ở nơi khác nên phiên này bị ngắt. Bấm Kết nối lại.' : `Mất kết nối Zalo (${code}).` })
  })
  l.on('error', () => {})
  l.start({ retryOnClose: true })
}

/** Friend and group names, so threads show who they are. */
async function loadNames(a: API): Promise<void> {
  try {
    const friends = await a.getAllFriends()
    for (const f of friends) names.set(f.userId, f.displayName || f.zaloName)
    for (const t of threads.values()) if (!t.group && names.has(t.id)) t.name = names.get(t.id)!
    scheduleSave()
  } catch {
    /* names are a nicety */
  }
  try {
    const ids = Object.keys((await a.getAllGroups()).gridVerMap)
    for (let i = 0; i < ids.length; i += 50) {
      const info = await a.getGroupInfo(ids.slice(i, i + 50))
      for (const [gid, g] of Object.entries(info.gridInfoMap)) {
        names.set(gid, g.name)
        const t = threads.get(gid)
        if (t) t.name = g.name
        else threads.set(gid, { id: gid, group: true, name: g.name, lastTs: 0, last: '' })
      }
    }
    scheduleSave()
  } catch {
    /* ignore */
  }
}

/** Start: log in with the saved session, if any. */
export function initZalo(win: () => BrowserWindow | null): void {
  getWin = win
  loadCache()
  if (readCreds()) void reconnect()
}

export async function reconnect(): Promise<ZaloState> {
  const creds = readCreds()
  if (!creds) {
    setState({ status: 'off' })
    return state
  }
  stopListener()
  setState({ status: 'connecting', error: undefined })
  try {
    await afterLogin(await newZalo().login(creds))
  } catch (e) {
    setState({ status: 'error', error: `Không đăng nhập lại được: ${e instanceof Error ? e.message : String(e)}. Hãy đăng nhập lại bằng QR.` })
  }
  return state
}

export async function loginQR(): Promise<void> {
  stopListener()
  setState({ status: 'qr', qr: undefined, error: undefined })
  try {
    const a = await newZalo().loginQR({}, (ev) => {
      switch (ev.type) {
        case LoginQRCallbackEventType.QRCodeGenerated:
          abortQR = ev.actions.abort
          setState({ status: 'qr', qr: 'data:image/png;base64,' + ev.data.image, scanned: undefined })
          break
        case LoginQRCallbackEventType.QRCodeExpired:
          setState({ status: 'qr', qr: undefined, error: 'Mã QR đã hết hạn.' })
          ev.actions.abort()
          break
        case LoginQRCallbackEventType.QRCodeScanned:
          setState({ scanned: ev.data.display_name })
          break
        case LoginQRCallbackEventType.QRCodeDeclined:
          setState({ status: 'off', qr: undefined, error: 'Đã từ chối đăng nhập trên điện thoại.' })
          ev.actions.abort()
          break
        case LoginQRCallbackEventType.GotLoginInfo:
          void saveCreds({ imei: ev.data.imei, cookie: ev.data.cookie, userAgent: ev.data.userAgent })
          break
      }
    })
    abortQR = null
    await afterLogin(a)
  } catch (e) {
    abortQR = null
    if (state.status === 'qr') setState({ status: state.error ? 'qr' : 'off', qr: undefined, error: state.error ?? (e instanceof Error ? e.message : String(e)) })
  }
}

export function cancelLogin(): void {
  abortQR?.()
  abortQR = null
  setState({ status: 'off', qr: undefined, scanned: undefined, error: undefined })
}

function stopListener(): void {
  const a = api
  api = null
  try {
    a?.listener.stop()
  } catch {
    /* already stopped */
  }
}

/** Forget the session and everything cached. */
export async function logout(): Promise<void> {
  stopListener()
  threads.clear()
  messages.clear()
  names.clear()
  await fsp.rm(dir(), { recursive: true, force: true }).catch(() => {})
  setState({ status: 'off', self: undefined, qr: undefined, error: undefined })
  getWin()?.webContents.send('zalo:changed')
}

export const getState = (): ZaloState => state

/* ---------------- reading / sending ---------------- */

function need(): API {
  if (!api || state.status !== 'online') throw new Error('Zalo chưa đăng nhập. Mở tab Zalo trong VIBE CODE và quét QR (hoặc bấm Kết nối lại).')
  return api
}

export function listThreads(query = '', limit = 200): ZaloThread[] {
  loadCache()
  const q = query.trim().toLowerCase()
  return [...threads.values()]
    .filter((t) => !q || t.name.toLowerCase().includes(q) || t.id.includes(q))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit)
}

export function getMessages(threadId: string, limit = 50, before?: number): ZaloMessage[] {
  loadCache()
  const all = messages.get(threadId) ?? []
  const list = before ? all.filter((m) => m.ts < before) : all
  return list.slice(-limit)
}

/** Older messages of a group from Zalo's cloud (1-to-1 chats only have what the socket replayed). */
export async function loadOlder(threadId: string, pages = 3): Promise<number> {
  const a = need()
  const t = threads.get(threadId)
  if (!t?.group) return 0
  const before = (messages.get(threadId) ?? []).length
  let cursor: string | undefined = messages.get(threadId)?.[0]?.id
  let isOld: number | undefined
  for (let i = 0; i < pages; i++) {
    const r = await a.getCloudMessage(threadId, cursor, { isOld })
    ingest(r.groupMsgs)
    if (!r.hasMore || (!r.groupMsgs.length && r.isFiltered)) break
    cursor = r.lastMsgId
    isOld = r.isOld
  }
  return (messages.get(threadId) ?? []).length - before
}

export function searchMessages(query: string, threadId?: string, limit = 50): ZaloMessage[] {
  loadCache()
  const q = query.toLowerCase()
  const pool = threadId ? messages.get(threadId) ?? [] : [...messages.values()].flat()
  return pool
    .filter((m) => m.text.toLowerCase().includes(q) || m.fromName.toLowerCase().includes(q))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}

export async function sendText(threadId: string, text: string, group?: boolean): Promise<string> {
  const a = need()
  const isGroup = group ?? threads.get(threadId)?.group ?? false
  const r = await a.sendMessage(text, threadId, isGroup ? ThreadType.Group : ThreadType.User)
  return String(r.message?.msgId ?? '')
}

/* ---------------- Claude tools (MCP server "vibe-zalo") ---------------- */

export const ZALO_INSTRUCTIONS =
  "Read (and, only when the user asks, send) messages of the user's personal Zalo account connected in VIBE CODE's Zalo tab. Start with zalo_list_chats to find a thread id, then zalo_read_messages. Message history is what VIBE CODE has synced since login plus recent history Zalo replays; groups can load older messages with zalo_read_messages {older: true}."

export const ZALO_TOOLS = [
  {
    name: 'zalo_status',
    description: 'Whether Zalo is logged in, and as whom.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'zalo_list_chats',
    description: 'Recent Zalo conversations (people and groups), newest first: thread id, name, type, time and last message. `query` filters by name.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 30' } } }
  },
  {
    name: 'zalo_read_messages',
    description:
      'Messages of one conversation, oldest first. `before` (ms timestamp) pages back through the synced history. For groups, `older: true` first fetches older messages from Zalo.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        limit: { type: 'number', description: 'default 50, max 500' },
        before: { type: 'number' },
        older: { type: 'boolean' }
      },
      required: ['threadId']
    }
  },
  {
    name: 'zalo_search_messages',
    description: 'Search synced Zalo messages by text or sender name (all conversations, or one `threadId`). Newest first.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, threadId: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
  },
  {
    name: 'zalo_contacts',
    description: 'Zalo friends and groups with their ids. `query` filters by name.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    name: 'zalo_find_user',
    description: 'Look up a Zalo user by phone number (returns their id and name).',
    inputSchema: { type: 'object', properties: { phone: { type: 'string' } }, required: ['phone'] }
  },
  {
    name: 'zalo_send_message',
    description:
      "Send a text message from the user's own Zalo account. Only when the user explicitly asked you to send this message to this person or group; show them the exact text and recipient first if there is any doubt.",
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' }, text: { type: 'string' }, group: { type: 'boolean', description: 'true for a group thread (auto-detected for known threads)' } },
      required: ['threadId', 'text']
    }
  }
]

const fmtTime = (ts: number): string => (ts ? new Date(ts).toLocaleString('vi-VN', { hour12: false }) : '-')
const fmtMsg = (m: ZaloMessage): string =>
  `[${fmtTime(m.ts)}] ${m.self ? 'Tôi' : m.fromName}${m.group ? ` (${m.fromId})` : ''}: ${m.quote ? `↪ «${m.quote.slice(0, 80)}» ` : ''}${m.text}`

export async function callZaloTool(name: string, args: Record<string, unknown>): Promise<string> {
  const num = (v: unknown, d: number, max: number): number => Math.min(max, Math.max(1, Number(v) || d))
  switch (name) {
    case 'zalo_status':
      return state.status === 'online'
        ? `Logged in as ${state.self?.name} (id ${state.self?.id}). ${threads.size} conversations cached.`
        : `Not logged in (${state.status}${state.error ? ': ' + state.error : ''}). Ask the user to open the Zalo tab in VIBE CODE and scan the QR code.`
    case 'zalo_list_chats': {
      const list = listThreads(String(args.query ?? ''), num(args.limit, 30, 500))
      if (!list.length) return 'No conversations synced yet.'
      return list.map((t) => `${t.group ? 'group' : 'user '} ${t.id}  ${t.name || '(no name)'}  · ${fmtTime(t.lastTs)}  · ${t.last}`).join('\n')
    }
    case 'zalo_read_messages': {
      const id = String(args.threadId ?? '')
      let note = ''
      if (args.older) note = `Fetched ${await loadOlder(id)} older messages.\n`
      const list = getMessages(id, num(args.limit, 50, 500), typeof args.before === 'number' ? args.before : undefined)
      const t = threads.get(id)
      const head = `${t?.group ? 'Group' : 'Chat with'} ${t?.name || id}\n`
      if (!list.length) return head + note + 'No messages synced for this conversation.'
      return head + note + list.map(fmtMsg).join('\n') + `\n(oldest ts here: ${list[0].ts} — pass as \`before\` for earlier messages)`
    }
    case 'zalo_search_messages': {
      const list = searchMessages(String(args.query ?? ''), args.threadId ? String(args.threadId) : undefined, num(args.limit, 50, 500))
      if (!list.length) return 'No matches.'
      return list.map((m) => `${threads.get(m.threadId)?.name || m.threadId} (${m.threadId}) ${fmtMsg(m)}`).join('\n')
    }
    case 'zalo_contacts': {
      const q = String(args.query ?? '').toLowerCase()
      const rows = [...names.entries()].filter(([, n]) => !q || n.toLowerCase().includes(q))
      if (!rows.length) return 'No contacts match.'
      return rows
        .slice(0, 500)
        .map(([id, n]) => `${threads.get(id)?.group ? 'group' : 'user '} ${id}  ${n}`)
        .join('\n')
    }
    case 'zalo_find_user': {
      const u = await need().findUser(String(args.phone ?? ''))
      return u?.uid ? `id ${u.uid}  ${u.display_name || u.zalo_name}` : 'Not found.'
    }
    case 'zalo_send_message': {
      const id = await sendText(String(args.threadId ?? ''), String(args.text ?? ''), typeof args.group === 'boolean' ? args.group : undefined)
      return `Sent (msgId ${id}).`
    }
  }
  throw new Error(`Unknown tool ${name}`)
}
