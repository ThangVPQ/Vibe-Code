import { app, nativeImage, safeStorage, type BrowserWindow } from 'electron'
import { promises as fsp, readFileSync } from 'fs'
import { join } from 'path'
import {
  LoginQRCallbackEventType,
  ThreadType,
  Zalo,
  type API,
  type Credentials,
  type Message,
  type Reaction,
  type Reactions,
  type SendMessageQuote,
  type Undo
} from 'zca-js'
import type { ZaloAttachment, ZaloMessage, ZaloState, ZaloSticker, ZaloThread, ZaloThreadInfo } from '../shared/types'

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
/** userId / groupId → display name (friends, groups, senders seen) */
const names = new Map<string, string>()
/** userId / groupId → avatar url */
const avatars = new Map<string, string>()
/** ids of my friends (for the contact list) */
const friends = new Set<string>()
/** stickerId → image url */
const stickerUrls = new Map<number, string>()
/** when this app was last online with Zalo: replayed messages newer than that arrived while away (unread) */
let syncedAt = 0
let awayFrom = 0
let cacheLoaded = false
let saveTimer: NodeJS.Timeout | null = null
let changedTimer: NodeJS.Timeout | null = null
const changedIds = new Set<string>()
/** the conversation open in the Zalo tab (its messages count as read) */
let activeThread: string | null = null

function loadCache(): void {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const c = JSON.parse(readFileSync(cacheFile(), 'utf8')) as {
      threads?: ZaloThread[]
      messages?: Record<string, ZaloMessage[]>
      names?: Record<string, string>
      avatars?: Record<string, string>
      friends?: string[]
      stickers?: Record<string, string>
      syncedAt?: number
    }
    for (const t of c.threads ?? []) threads.set(t.id, t)
    for (const [k, v] of Object.entries(c.messages ?? {})) messages.set(k, v)
    for (const [k, v] of Object.entries(c.names ?? {})) names.set(k, v)
    for (const [k, v] of Object.entries(c.avatars ?? {})) avatars.set(k, v)
    for (const id of c.friends ?? []) friends.add(id)
    for (const [k, v] of Object.entries(c.stickers ?? {})) stickerUrls.set(Number(k), v)
    syncedAt = awayFrom = c.syncedAt ?? 0
  } catch {
    /* no cache yet */
  }
}

/** Something changed in these conversations: tell the window soon, write the disk a little later. */
function changed(...ids: string[]): void {
  for (const id of ids) changedIds.add(id)
  if (!changedTimer)
    changedTimer = setTimeout(() => {
      changedTimer = null
      const list = [...changedIds]
      changedIds.clear()
      getWin()?.webContents.send('zalo:changed', list)
    }, 120)
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void writeCache()
  }, 3000)
}

async function writeCache(): Promise<void> {
  if (state.status === 'online') syncedAt = Date.now()
  const data = {
    threads: [...threads.values()].filter((t) => !t.contact),
    messages: Object.fromEntries(messages),
    names: Object.fromEntries(names),
    avatars: Object.fromEntries(avatars),
    friends: [...friends],
    stickers: Object.fromEntries(stickerUrls),
    syncedAt
  }
  await fsp.mkdir(dir(), { recursive: true })
  await fsp.writeFile(cacheFile(), JSON.stringify(data), 'utf8').catch(() => {})
}

/* ---------------- parsing Zalo messages ---------------- */

const KIND_LABEL: Record<string, string> = {
  photo: 'Ảnh',
  video: 'Video',
  voice: 'Tin nhắn thoại',
  sticker: 'Sticker',
  gif: 'GIF',
  file: 'File',
  link: 'Link',
  location: 'Vị trí',
  card: 'Danh thiếp',
  other: 'Tin nhắn'
}
export const attachLabel = (a: ZaloAttachment): string => KIND_LABEL[a.kind] ?? 'Tin nhắn'

function parseJson(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v !== 'string' || !v.trim().startsWith('{')) return {}
  try {
    return JSON.parse(v) as Record<string, unknown>
  } catch {
    return {}
  }
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** What an attachment message carries, in one shape for the UI. */
function parseAttachment(msgType: string, content: unknown): ZaloAttachment | undefined {
  if (typeof content === 'string' || !content || typeof content !== 'object') return undefined
  const c = content as Record<string, unknown>
  const p = parseJson(c.params)
  const base = { url: str(c.href), thumb: str(c.thumb), title: str(c.title), desc: str(c.description) }
  const t = msgType.replace(/^(chat|share)\./, '')
  if (t === 'photo' || t === 'doodle')
    return { kind: 'photo', ...base, url: str(p.hd) ?? str(p.rawUrl) ?? base.url, width: num(p.width), height: num(p.height) }
  if (t.startsWith('video'))
    return { kind: 'video', ...base, width: num(p.video_width), height: num(p.video_height), duration: num(p.duration) ? num(p.duration)! / 1000 : undefined }
  if (t === 'voice') return { kind: 'voice', ...base, duration: num(p.duration) ? num(p.duration)! / 1000 : undefined }
  if (t === 'gif') return { kind: 'gif', ...base, width: num(p.width), height: num(p.height) }
  if (t === 'sticker') {
    const id = num(c.id)
    return id ? { kind: 'sticker', sticker: { id, cateId: Number(c.catId ?? c.cateId) || 0, type: Number(c.type) || 0 }, url: stickerUrls.get(id) } : undefined
  }
  if (t === 'file') return { kind: 'file', ...base, size: num(p.fileSize), ext: str(p.fileExt)?.toLowerCase() }
  if (t.startsWith('location')) return { kind: 'location', ...base }
  if (t === 'recommended' || t === 'link') {
    const action = str(c.action) ?? ''
    if (action.includes('user')) return { kind: 'card', ...base, desc: str(p.phone) ?? base.desc }
    return { kind: 'link', ...base }
  }
  return { kind: 'other', ...base }
}

/** Readable text for any Zalo message: plain text as is, attachments as "[kind] title url". */
function contentText(att: ZaloAttachment | undefined, content: unknown): string {
  if (typeof content === 'string') return content
  if (!att) return '[tin nhắn]'
  const parts = [`[${attachLabel(att).toLowerCase()}]`]
  for (const v of [att.title, att.desc, att.url]) if (v && !parts.includes(v)) parts.push(v)
  return parts.join(' ')
}

/** One line for the conversation list. */
function previewOf(m: ZaloMessage): string {
  if (m.recalled) return 'Tin nhắn đã thu hồi'
  if (!m.att) return m.text
  const a = m.att
  if (a.kind === 'file') return `📎 ${a.title ?? 'File'}`
  if (a.kind === 'photo') return `🖼 ${a.title ?? 'Ảnh'}`
  if (a.kind === 'video') return `🎬 ${a.title ?? 'Video'}`
  if (a.kind === 'voice') return '🎤 Tin nhắn thoại'
  if (a.kind === 'sticker') return 'Sticker'
  if (a.kind === 'gif') return 'GIF'
  if (a.kind === 'link') return `🔗 ${a.title ?? a.url ?? 'Link'}`
  if (a.kind === 'location') return `📍 ${a.title ?? 'Vị trí'}`
  if (a.kind === 'card') return `👤 ${a.title ?? 'Danh thiếp'}`
  return a.title ?? m.text
}

function refreshThreadLast(threadId: string): void {
  const t = threads.get(threadId)
  const last = messages.get(threadId)?.at(-1)
  if (!t || !last) return
  t.lastTs = last.ts
  t.last = (t.group && !last.self ? `${last.fromName}: ` : '') + previewOf(last).slice(0, 200)
  t.lastSelf = last.self
  t.lastStatus = last.self ? last.status : undefined
}

function toMessage(m: Message): ZaloMessage {
  const d = m.data
  const isGroup = m.type === ThreadType.Group
  const att = parseAttachment(d.msgType, d.content)
  const fromId = m.isSelf ? state.self?.id ?? String(d.uidFrom) : String(d.uidFrom)
  const q = d.quote
  const mentions = 'mentions' in d && Array.isArray(d.mentions) ? d.mentions.map((x) => ({ uid: String(x.uid), pos: x.pos, len: x.len })) : undefined
  return {
    id: String(d.msgId),
    cliMsgId: String(d.cliMsgId),
    threadId: m.threadId,
    group: isGroup,
    fromId,
    fromName: m.isSelf ? 'Tôi' : d.dName || names.get(String(d.uidFrom)) || String(d.uidFrom),
    self: m.isSelf,
    ts: Number(d.ts) || Date.now(),
    type: d.msgType,
    text: contentText(att, d.content),
    att,
    mentions: mentions?.length ? mentions : undefined,
    quote: q?.msg || q?.attach ? `${q.fromD}: ${q.msg || '[tệp đính kèm]'}` : undefined,
    reply: q ? { id: String(q.globalMsgId), from: q.fromD, text: q.msg || (q.attach ? '[tệp đính kèm]' : '') } : undefined,
    status: m.isSelf ? 'sent' : undefined,
    raw: {
      content: d.content,
      msgType: d.msgType,
      propertyExt: d.propertyExt,
      uidFrom: String(d.uidFrom),
      idTo: String(d.idTo),
      ttl: d.ttl,
      st: d.st,
      at: d.at,
      cmd: d.cmd
    }
  }
}

/** Store messages. `live`: just arrived (counts as unread). */
function ingest(list: Message[], live = false): void {
  if (!list.length) return
  loadCache()
  const touched = new Set<string>()
  for (const m of list) {
    const msg = toMessage(m)
    if (!m.isSelf && m.data.dName) names.set(msg.fromId, m.data.dName)
    const arr = messages.get(m.threadId) ?? []
    if (arr.some((x) => x.id === msg.id)) continue
    arr.push(msg)
    if (arr.length > 1 && arr[arr.length - 2].ts > msg.ts) arr.sort((a, b) => a.ts - b.ts)
    if (arr.length > MAX_PER_THREAD) arr.splice(0, arr.length - MAX_PER_THREAD)
    messages.set(m.threadId, arr)
    const t = threads.get(m.threadId) ?? { id: m.threadId, group: msg.group, name: '', lastTs: 0, last: '' }
    delete t.contact
    if (!t.name && !msg.group && !m.isSelf && m.data.dName) t.name = m.data.dName
    if (!t.name) t.name = names.get(m.threadId) ?? ''
    if (!t.avatar && avatars.has(m.threadId)) t.avatar = avatars.get(m.threadId)
    threads.set(m.threadId, t)
    if (msg.ts >= t.lastTs) refreshThreadLast(m.threadId)
    // replayed history: unread if it came in while the app was away and I haven't replied since
    const away = !live && awayFrom > 0 && msg.ts > awayFrom && !arr.some((x) => x.self && x.ts > msg.ts)
    if (msg.self && msg.ts >= t.lastTs) t.unread = 0
    else if ((live || away) && !msg.self) {
      const focused = getWin()?.isFocused() && activeThread === m.threadId
      if (focused) markSeen(m.threadId)
      else t.unread = (t.unread ?? 0) + 1
    }
    if (msg.att?.kind === 'sticker' && !msg.att.url) void resolveSticker(msg)
    if (msg.group && !m.isSelf && !avatars.has(msg.fromId)) wantProfile(msg.fromId)
    touched.add(m.threadId)
  }
  changed(...touched)
  if (live && touched.size) ingestHook?.([...touched])
}

let ingestHook: ((threadIds: string[]) => void) | null = null
/** Called with the conversations that just got live messages. */
export function onIngest(cb: (threadIds: string[]) => void): void {
  ingestHook = cb
}

export interface WorkMsg {
  id: string
  ts: number
  from: string
  fromId: string
  self: boolean
  /** sent to me: a personal chat, an @mention of me, or a reply to my message */
  toMe: boolean
  text: string
}
export interface WorkThread {
  threadId: string
  name: string
  group: boolean
  msgs: WorkMsg[]
}

/**
 * Conversations with something addressed to me since `since`: every personal chat with an incoming message,
 * and groups where someone @mentioned me or replied to me — with my own later messages, so it's clear what I answered.
 */
export function workFeed(since: number, maxThreads = 40, maxMsgs = 40): WorkThread[] {
  loadCache()
  const me = state.self?.id
  const out: WorkThread[] = []
  for (const t of threads.values()) {
    const arr = messages.get(t.id)
    if (!arr?.length || arr[arr.length - 1].ts < since) continue
    const mine = new Set(arr.filter((m) => m.self).map((m) => m.id))
    const recent = arr.filter((m) => m.ts >= since && !m.recalled)
    const toMe = (m: ZaloMessage): boolean =>
      !m.self && (!t.group || !!m.mentions?.some((x) => x.uid === me) || (!!m.reply && mine.has(m.reply.id)))
    const first = recent.findIndex(toMe)
    if (first < 0) continue
    // personal: the whole recent chat; group: messages to me + what I wrote after the first one
    const pick = recent.slice(first).filter((m) => !t.group || m.self || toMe(m))
    const msgs = pick.slice(-maxMsgs).map((m) => ({
      id: m.id,
      ts: m.ts,
      from: m.self ? 'Tôi' : m.fromName,
      fromId: m.fromId,
      self: m.self,
      toMe: toMe(m),
      text: ((m.reply ? `[trả lời ${m.reply.from}: "${m.reply.text.slice(0, 80)}"] ` : '') + (m.text || previewOf(m))).slice(0, 600)
    }))
    out.push({ threadId: t.id, name: t.name || t.id, group: t.group, msgs })
  }
  return out.sort((a, b) => b.msgs[b.msgs.length - 1].ts - a.msgs[a.msgs.length - 1].ts).slice(0, maxThreads)
}

export const selfId = (): string | undefined => state.self?.id

/** A user's avatar url, if known (queues a profile fetch otherwise). */
export function avatarOf(userId: string): string | undefined {
  loadCache()
  const a = avatars.get(userId)
  if (!a) wantProfile(userId)
  return a
}

/* ---------------- profiles & stickers, fetched lazily ---------------- */

const profileQueue = new Set<string>()
let profileTimer: NodeJS.Timeout | null = null
function wantProfile(uid: string): void {
  if (!api || profileQueue.has(uid)) return
  profileQueue.add(uid)
  profileTimer ??= setTimeout(() => void flushProfiles(), 800)
}
async function flushProfiles(): Promise<void> {
  profileTimer = null
  const a = api
  const ids = [...profileQueue].filter((id) => !avatars.has(id)).slice(0, 100)
  if (!a || !ids.length) return
  try {
    const r = await a.getUserInfo(ids)
    for (const [k, p] of Object.entries(r.changed_profiles ?? {})) {
      const id = k.replace(/_0$/, '')
      if (p.avatar) avatars.set(id, p.avatar)
      if (p.displayName || p.zaloName) names.set(id, p.displayName || p.zaloName)
      const t = threads.get(id)
      if (t) {
        if (p.avatar) t.avatar = p.avatar
        if (!t.name) t.name = p.displayName || p.zaloName
      }
    }
    changed(...threads.keys())
  } catch {
    /* avatars are a nicety */
  }
}

async function resolveSticker(m: ZaloMessage): Promise<void> {
  const s = m.att?.sticker
  if (!s || !api) return
  try {
    if (!stickerUrls.has(s.id)) {
      const [d] = await api.getStickersDetail(s.id)
      const url = d?.stickerWebpUrl || d?.stickerUrl
      if (url) stickerUrls.set(s.id, url)
    }
    const url = stickerUrls.get(s.id)
    if (url && m.att) {
      m.att.url = url
      changed(m.threadId)
    }
  } catch {
    /* shown as "Sticker" */
  }
}

/* ---------------- live events: reactions, recalls, seen, typing ---------------- */

const findMsg = (threadId: string, msgId: string): ZaloMessage | undefined => messages.get(threadId)?.find((m) => m.id === msgId)

function applyReaction(r: Reaction): void {
  const d = r.data
  const uid = String(d.uidFrom)
  for (const target of d.content?.rMsg ?? []) {
    const m = findMsg(r.threadId, String(target.gMsgID))
    if (!m) continue
    const reactions = { ...(m.reactions ?? {}) }
    for (const k of Object.keys(reactions)) {
      reactions[k] = reactions[k].filter((u) => u !== uid)
      if (!reactions[k].length) delete reactions[k]
    }
    const icon = d.content.rIcon
    if (icon) reactions[icon] = [...(reactions[icon] ?? []), uid]
    m.reactions = Object.keys(reactions).length ? reactions : undefined
    changed(r.threadId)
  }
}

function applyUndo(u: Undo): void {
  const m = findMsg(u.threadId, String(u.data.content.globalMsgId))
  if (!m) return
  m.recalled = true
  m.text = 'Tin nhắn đã được thu hồi'
  m.att = undefined
  m.reply = undefined
  m.reactions = undefined
  refreshThreadLast(u.threadId)
  changed(u.threadId)
}

/** My messages up to `msgId` in this thread were read by the other side. */
function markMineSeen(threadId: string, msgId: string): void {
  const arr = messages.get(threadId)
  if (!arr) return
  const upTo = arr.find((m) => m.id === msgId)?.ts ?? Infinity
  for (const m of arr) if (m.self && m.ts <= upTo && m.status === 'sent') m.status = 'seen'
  refreshThreadLast(threadId)
  changed(threadId)
}

/** Tell Zalo (and the sender) we read this conversation. */
function markSeen(threadId: string): void {
  const t = threads.get(threadId)
  if (t?.unread) {
    t.unread = 0
    changed(threadId)
  }
  const a = api
  if (!a || state.status !== 'online') return
  const unseen = (messages.get(threadId) ?? []).filter((m) => !m.self && m.raw).slice(-20)
  if (!unseen.length) return
  const params = unseen.map((m) => ({
    msgId: m.id,
    cliMsgId: m.cliMsgId,
    uidFrom: m.raw!.uidFrom,
    idTo: m.raw!.idTo,
    msgType: m.raw!.msgType,
    st: m.raw!.st,
    at: m.raw!.at,
    cmd: m.raw!.cmd,
    ts: m.ts
  }))
  a.sendSeenEvent(params, t?.group ? ThreadType.Group : ThreadType.User).catch(() => {})
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

/** zca-js needs an image's size before uploading it as a photo */
async function imageMetadata(path: string): Promise<{ width: number; height: number; size: number } | null> {
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  return { width, height, size: (await fsp.stat(path)).size }
}

const newZalo = (): Zalo => new Zalo({ selfListen: true, checkUpdate: false, logging: false, imageMetadataGetter: imageMetadata })

const OLD_PAGES = 15
let retries = 0
let retryTimer: NodeJS.Timeout | null = null

async function afterLogin(a: API): Promise<void> {
  api = a
  retries = 0
  loadCache()
  awayFrom = syncedAt
  const id = a.getOwnId()
  setState({ status: 'online', qr: undefined, error: undefined, self: { id, name: state.self?.name ?? '', avatar: state.self?.avatar ?? '' } })
  a.fetchAccountInfo()
    .then((r) => setState({ self: { id, name: r.profile.displayName || r.profile.zaloName, avatar: r.profile.avatar } }))
    .catch(() => {})
  void loadNames(a)
  void loadPins(a)

  // recent history: Zalo replays it page by page over the socket, once the socket has its key
  const l = a.listener
  l.on('cipher_key', () => {
    if (api === a) requestReplay(a)
  })
  l.on('message', (m) => ingest([m], true))
  l.on('old_messages', (list, type) => {
    ingest(list)
    if (list.length && ++replayPages[type] < OLD_PAGES) {
      const oldest = list.reduce((x, y) => (Number(x.data.ts) <= Number(y.data.ts) ? x : y))
      l.requestOldMessages(type, oldest.data.msgId)
    }
  })
  l.on('reaction', applyReaction)
  l.on('old_reactions', (list) => list.forEach(applyReaction))
  l.on('undo', applyUndo)
  l.on('seen_messages', (list) => {
    for (const s of list) {
      if (s.isSelf) continue
      markMineSeen(s.threadId, String(s.data.msgId))
    }
  })
  l.on('typing', (t) => {
    const uid = String(t.data.uid)
    getWin()?.webContents.send('zalo:typing', { threadId: t.threadId, uid, name: names.get(uid) ?? '' })
  })
  l.on('closed', (code) => {
    if (api !== a) return
    // 3000: the account opened Zalo Web somewhere else — only one web session may listen
    if (code === 3000) {
      setState({ status: 'error', error: 'Zalo Web đang mở ở nơi khác nên phiên này bị ngắt. Bấm Kết nối lại.' })
      return
    }
    if (retries < 5) {
      retries++
      setState({ status: 'connecting', error: undefined })
      retryTimer = setTimeout(() => void reconnect(true), 2000 * retries)
      return
    }
    setState({ status: 'error', error: `Mất kết nối Zalo (${code}).` })
  })
  l.on('error', () => {})
  l.start({ retryOnClose: true })
}

const replayPages = { [ThreadType.User]: 0, [ThreadType.Group]: 0 }
function requestReplay(a: API): void {
  const l = a.listener
  replayPages[ThreadType.User] = replayPages[ThreadType.Group] = 0
  l.requestOldMessages(ThreadType.User)
  l.requestOldMessages(ThreadType.Group)
  l.requestOldReactions(ThreadType.User)
  l.requestOldReactions(ThreadType.Group)
}

/** "Đồng bộ tất cả": names, pins, the socket replay again, and the latest page of every group. Returns new messages. */
export async function syncAll(): Promise<number> {
  const a = need()
  const total = (): number => [...messages.values()].reduce((s, m) => s + m.length, 0)
  const before = total()
  await Promise.all([loadNames(a), loadPins(a)])
  requestReplay(a)
  const groups = [...threads.values()].filter((t) => t.group).map((t) => t.id)
  for (let i = 0; i < groups.length; i += 4)
    await Promise.all(
      groups.slice(i, i + 4).map((id) =>
        a
          .getCloudMessage(id)
          .then((r) => ingest(r.groupMsgs))
          .catch(() => {})
      )
    )
  return total() - before
}

/** Friend and group names / avatars, so threads show who they are. */
async function loadNames(a: API): Promise<void> {
  try {
    const list = await a.getAllFriends()
    friends.clear()
    for (const f of list) {
      friends.add(f.userId)
      names.set(f.userId, f.displayName || f.zaloName)
      if (f.avatar) avatars.set(f.userId, f.avatar)
    }
    for (const t of threads.values())
      if (!t.group) {
        if (names.has(t.id)) t.name = names.get(t.id)!
        if (avatars.has(t.id)) t.avatar = avatars.get(t.id)
      }
    changed(...threads.keys())
  } catch {
    /* names are a nicety */
  }
  try {
    const ids = Object.keys((await a.getAllGroups()).gridVerMap)
    for (let i = 0; i < ids.length; i += 50) {
      const info = await a.getGroupInfo(ids.slice(i, i + 50))
      for (const [gid, g] of Object.entries(info.gridInfoMap)) {
        names.set(gid, g.name)
        if (g.avt) avatars.set(gid, g.avt)
        const t = threads.get(gid) ?? { id: gid, group: true, name: g.name, lastTs: 0, last: '' }
        t.name = g.name
        t.avatar = g.avt || undefined
        t.members = g.totalMember
        threads.set(gid, t)
      }
    }
    changed(...threads.keys())
  } catch {
    /* ignore */
  }
}

async function loadPins(a: API): Promise<void> {
  try {
    const r = await a.getPinConversations()
    const pinned = new Map(r.conversations.map((c) => [c.replace(/^[ug]/, ''), c.startsWith('g')]))
    for (const t of threads.values()) t.pinned = pinned.has(t.id) || undefined
    for (const [id, group] of pinned)
      if (!threads.has(id)) threads.set(id, { id, group, name: names.get(id) ?? '', avatar: avatars.get(id), lastTs: 0, last: '', pinned: true })
    for (const [id, group] of pinned) if (!group && !avatars.has(id)) wantProfile(id)
    changed(...pinned.keys())
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

export async function reconnect(auto = false): Promise<ZaloState> {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  if (!auto) retries = 0
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
  if (retryTimer) clearTimeout(retryTimer)
  stopListener()
  threads.clear()
  messages.clear()
  names.clear()
  avatars.clear()
  friends.clear()
  await fsp.rm(dir(), { recursive: true, force: true }).catch(() => {})
  setState({ status: 'off', self: undefined, qr: undefined, error: undefined })
  getWin()?.webContents.send('zalo:changed', [])
}

export const getState = (): ZaloState => state

/* ---------------- reading ---------------- */

function need(): API {
  if (!api || state.status !== 'online') throw new Error('Zalo chưa đăng nhập. Mở tab Zalo trong VIBE CODE và quét QR (hoặc bấm Kết nối lại).')
  return api
}

const typeOf = (threadId: string, group?: boolean): ThreadType => ((group ?? threads.get(threadId)?.group) ? ThreadType.Group : ThreadType.User)

export function listThreads(query = '', limit = 200): ZaloThread[] {
  loadCache()
  const q = query.trim().toLowerCase()
  return [...threads.values()]
    .filter((t) => !q || t.name.toLowerCase().includes(q) || t.id.includes(q))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit)
}

/** Conversations for the Zalo tab: everything with a name, pinned and newest first. */
export function uiThreads(): ZaloThread[] {
  loadCache()
  return [...threads.values()].filter((t) => t.name || t.lastTs).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastTs - a.lastTs)
}

/** Friends, for the contact list (with their thread if one exists). */
export function contacts(): ZaloThread[] {
  loadCache()
  return [...friends]
    .map((id) => threads.get(id) ?? { id, group: false, name: names.get(id) ?? id, avatar: avatars.get(id), lastTs: 0, last: '', contact: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
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

/** The conversation open in the tab (null when none): its messages are read as they come. */
export function setActive(threadId: string | null): void {
  activeThread = threadId
  if (threadId) markSeen(threadId)
}

export async function threadInfo(threadId: string): Promise<ZaloThreadInfo> {
  const t = threads.get(threadId)
  const info: ZaloThreadInfo = {
    id: threadId,
    name: t?.name || names.get(threadId) || threadId,
    avatar: t?.avatar ?? avatars.get(threadId),
    group: !!t?.group,
    members: t?.members
  }
  const a = api
  if (!a) return info
  try {
    if (info.group) {
      const g = (await a.getGroupInfo(threadId)).gridInfoMap[threadId]
      if (g) {
        info.members = g.totalMember
        info.desc = g.desc || undefined
        info.avatar = g.fullAvt || g.avt || info.avatar
      }
    } else {
      const [p, o] = await Promise.all([
        a.getUserInfo(threadId).then((r) => Object.values(r.changed_profiles ?? {})[0]).catch(() => undefined),
        a.lastOnline(threadId).catch(() => undefined)
      ])
      if (p) {
        info.avatar = p.avatar || info.avatar
        info.phone = p.phoneNumber || undefined
        info.desc = p.status || undefined
      }
      if (o?.settings?.show_online_status) {
        info.lastOnline = o.lastOnline
        info.online = !!o.lastOnline && Date.now() - o.lastOnline * (o.lastOnline < 1e12 ? 1000 : 1) < 3 * 60_000
      }
    }
  } catch {
    /* basic info only */
  }
  return info
}

/* ---------------- sending & actions ---------------- */

function quoteOf(threadId: string, replyTo?: string): SendMessageQuote | undefined {
  const m = replyTo ? findMsg(threadId, replyTo) : undefined
  if (!m?.raw) return undefined
  return {
    content: m.raw.content as SendMessageQuote['content'],
    msgType: m.raw.msgType,
    propertyExt: m.raw.propertyExt as SendMessageQuote['propertyExt'],
    uidFrom: m.raw.uidFrom,
    msgId: m.id,
    cliMsgId: m.cliMsgId,
    ts: String(m.ts),
    ttl: m.raw.ttl
  }
}

export async function sendText(threadId: string, text: string, group?: boolean, replyTo?: string): Promise<string> {
  const a = need()
  const quote = quoteOf(threadId, replyTo)
  const r = await a.sendMessage(quote ? { msg: text, quote } : text, threadId, typeOf(threadId, group))
  return String(r.message?.msgId ?? '')
}

/** Files from disk (images are sent as photos), with an optional caption. */
export async function sendFiles(threadId: string, paths: string[], caption = ''): Promise<void> {
  const a = need()
  // forward slashes: zca-js takes an image's file name from after the last '/'
  await a.sendMessage({ msg: caption, attachments: paths.map((p) => p.replace(/\\/g, '/')) }, threadId, typeOf(threadId))
}

export async function sendSticker(threadId: string, s: ZaloSticker): Promise<void> {
  const a = need()
  stickerUrls.set(s.id, s.url)
  await a.sendSticker({ id: s.id, cateId: s.cateId, type: s.type }, threadId, typeOf(threadId))
}

export async function searchStickers(keyword: string): Promise<ZaloSticker[]> {
  const a = need()
  const ids = (await a.getStickers(keyword.trim() || 'hi')).slice(0, 48)
  if (!ids.length) return []
  const list = await a.getStickersDetail(ids)
  return list
    .map((d) => ({ id: d.id, cateId: d.cateId, type: d.type, url: d.stickerWebpUrl || d.stickerUrl }))
    .filter((s) => s.url)
}

export async function react(threadId: string, msgId: string, icon: string): Promise<void> {
  const a = need()
  const m = findMsg(threadId, msgId)
  if (!m) throw new Error('Không tìm thấy tin nhắn.')
  await a.addReaction(icon as Reactions, { data: { msgId: m.id, cliMsgId: m.cliMsgId }, threadId, type: typeOf(threadId) })
  // the listener echoes my reaction too; apply it now so the chip shows at once
  const me = state.self?.id ?? ''
  const reactions = { ...(m.reactions ?? {}) }
  for (const k of Object.keys(reactions)) {
    reactions[k] = reactions[k].filter((u) => u !== me)
    if (!reactions[k].length) delete reactions[k]
  }
  if (icon) reactions[icon] = [...(reactions[icon] ?? []), me]
  m.reactions = Object.keys(reactions).length ? reactions : undefined
  changed(threadId)
}

/** Recall my message for everyone. */
export async function recall(threadId: string, msgId: string): Promise<void> {
  const a = need()
  const m = findMsg(threadId, msgId)
  if (!m?.self) throw new Error('Chỉ thu hồi được tin nhắn của bạn.')
  await a.undo({ msgId: m.id, cliMsgId: m.cliMsgId }, threadId, typeOf(threadId))
  m.recalled = true
  m.text = 'Tin nhắn đã được thu hồi'
  m.att = undefined
  m.reply = undefined
  refreshThreadLast(threadId)
  changed(threadId)
}

/** Delete a message on my side only. */
export async function deleteForMe(threadId: string, msgId: string): Promise<void> {
  const a = need()
  const arr = messages.get(threadId) ?? []
  const m = arr.find((x) => x.id === msgId)
  if (!m) return
  await a.deleteMessage({ data: { cliMsgId: m.cliMsgId, msgId: m.id, uidFrom: m.raw?.uidFrom ?? m.fromId }, threadId, type: typeOf(threadId) }, true)
  arr.splice(arr.indexOf(m), 1)
  refreshThreadLast(threadId)
  changed(threadId)
}

export async function forward(fromThread: string, msgId: string, toThread: string): Promise<void> {
  const a = need()
  const m = findMsg(fromThread, msgId)
  if (!m) throw new Error('Không tìm thấy tin nhắn.')
  if (typeof m.raw?.content !== 'string') {
    // attachments: send the link again (Zalo's forward call takes text only)
    await a.sendMessage(m.att?.url ?? m.text, toThread, typeOf(toThread))
    return
  }
  const r = await a.forwardMessage({ message: m.raw.content }, [toThread], typeOf(toThread))
  if (r.fail?.length) throw new Error(`Chuyển tiếp lỗi (${r.fail[0].error_code}).`)
}

let lastTyping = 0
export function typing(threadId: string): void {
  const a = api
  if (!a || Date.now() - lastTyping < 3000) return
  lastTyping = Date.now()
  a.sendTypingEvent(threadId, typeOf(threadId)).catch(() => {})
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
  const n = (v: unknown, d: number, max: number): number => Math.min(max, Math.max(1, Number(v) || d))
  switch (name) {
    case 'zalo_status':
      return state.status === 'online'
        ? `Logged in as ${state.self?.name} (id ${state.self?.id}). ${threads.size} conversations cached.`
        : `Not logged in (${state.status}${state.error ? ': ' + state.error : ''}). Ask the user to open the Zalo tab in VIBE CODE and scan the QR code.`
    case 'zalo_list_chats': {
      const list = listThreads(String(args.query ?? ''), n(args.limit, 30, 500))
      if (!list.length) return 'No conversations synced yet.'
      return list.map((t) => `${t.group ? 'group' : 'user '} ${t.id}  ${t.name || '(no name)'}  · ${fmtTime(t.lastTs)}  · ${t.last}`).join('\n')
    }
    case 'zalo_read_messages': {
      const id = String(args.threadId ?? '')
      let note = ''
      if (args.older) note = `Fetched ${await loadOlder(id)} older messages.\n`
      const list = getMessages(id, n(args.limit, 50, 500), typeof args.before === 'number' ? args.before : undefined)
      const t = threads.get(id)
      const head = `${t?.group ? 'Group' : 'Chat with'} ${t?.name || id}\n`
      if (!list.length) return head + note + 'No messages synced for this conversation.'
      return head + note + list.map(fmtMsg).join('\n') + `\n(oldest ts here: ${list[0].ts} — pass as \`before\` for earlier messages)`
    }
    case 'zalo_search_messages': {
      const list = searchMessages(String(args.query ?? ''), args.threadId ? String(args.threadId) : undefined, n(args.limit, 50, 500))
      if (!list.length) return 'No matches.'
      return list.map((m) => `${threads.get(m.threadId)?.name || m.threadId} (${m.threadId}) ${fmtMsg(m)}`).join('\n')
    }
    case 'zalo_contacts': {
      const q = String(args.query ?? '').toLowerCase()
      const rows = [...names.entries()].filter(([, v]) => !q || v.toLowerCase().includes(q))
      if (!rows.length) return 'No contacts match.'
      return rows
        .slice(0, 500)
        .map(([id, v]) => `${threads.get(id)?.group ? 'group' : 'user '} ${id}  ${v}`)
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
