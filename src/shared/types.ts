import type { AgentId } from './agents'

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U' | '?' | 'C'

export interface GitFile {
  /** path relative to repo root, forward slashes */
  rel: string
  /** absolute path on disk */
  abs: string
  status: GitFileStatus
  staged: boolean
  added: number
  deleted: number
}

export interface GitState {
  isRepo: boolean
  root: string | null
  branch: string | null
  files: GitFile[]
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  /** unix ms */
  date: number
  subject: string
}

export interface GitCommitFile {
  rel: string
  status: GitFileStatus
  added: number
  deleted: number
}

export interface PtySpawnOptions {
  id: string
  cwd: string
  kind: 'claude' | 'shell'
  /** which coding agent a chat terminal runs — default Claude Code */
  agent?: AgentId
  /** extra args for claude (or the chat's agent), e.g. ['--continue'] or ['--resume', id] */
  claudeArgs?: string[]
  cols: number
  rows: number
}

export interface SessionInfo {
  id: string
  title: string
  /** folder the session ran in — `claude --resume` must run from here */
  cwd: string
  /** repo the session belongs to (worktree sessions roll up to their repo) */
  projectCwd: string
  created: number
  updated: number
  cwdExists: boolean
}

export interface ProjectGroup {
  key: string
  cwd: string
  name: string
  updated: number
  sessions: SessionInfo[]
}

export type WindowMode = 'window' | 'dropdown'
export type ThemePref = 'system' | 'light' | 'dark' | 'blue'

export interface AppSettings {
  recentFolders: string[]
  lastFolder: string | null
  /** 'dropdown' = Guake-style: slides from the top edge on a global hotkey */
  mode: WindowMode
  hotkey: string
  /** drop-down height as a fraction of the screen work area */
  dropHeight: number
  dropOpacity: number
  hideOnBlur: boolean
  theme: ThemePref
  /** defaults for new chats: '' = Claude Code's own default */
  model: string
  effort: string
  /** default | acceptEdits | plan | bypassPermissions — '' = Claude Code's own default */
  permissionMode: string
  /** Linux-style overlay: transparent window background, text stays solid (needs a relaunch) */
  seeThrough: boolean
  /** code editor (Monaco): font family name, size in px, ligatures */
  editorFont: string
  editorFontSize: number
  editorLigatures: boolean
}

export interface WindowState {
  mode: WindowMode
  maximized: boolean
  hotkey: string
  hotkeyOk: boolean
}

/** One plan limit from Claude's usage API (what /usage and the Claude app show). */
export interface UsageLimit {
  /** session = 5-hour window, weekly_all = all models this week, weekly_scoped = one model this week */
  kind: string
  label: string
  percent: number
  severity: string
  resetsAt: string | null
}

export interface AgentInfo {
  id: AgentId
  found: boolean
}

export interface ClaudeInfo {
  found: boolean
  path: string | null
  shell: string
}

/* ---------------- SQL Server (Database tab + Claude's mssql tools) ---------------- */

/** A saved connection as the UI sees it — no password. */
export interface DbConnection {
  id: string
  name: string
  server: string
  database: string
  auth: 'sql' | 'windows'
  user: string
  /** Claude's queries run in a transaction that is always rolled back */
  claudeReadOnly: boolean
  color?: string
}

export interface DbConnectionInput {
  id?: string
  name: string
  conn: string
  claudeReadOnly: boolean
  color?: string
}

/** A connection string found in the project or in SSMS, ready to add. */
export interface DbFound {
  name: string
  conn: string
  /** where it came from: a project file, or "SSMS 20.0" */
  file: string
  /** SSMS knew the server and login but had no saved password */
  needsPassword?: boolean
}

export interface DbObject {
  schema: string
  name: string
  /** U table, V view, P procedure, FN / IF / TF function */
  type: 'U' | 'V' | 'P' | 'FN' | 'IF' | 'TF'
}

export interface DbColumn {
  name: string
  type: string
  nullable: boolean
  identity: boolean
  pk: boolean
  /** foreign key target: schema.table.column */
  ref?: string
}

export interface DbResultSet {
  columns: { name: string; type: string }[]
  rows: unknown[][]
  truncated: boolean
}

export interface DbQueryResult {
  ok: boolean
  error?: string
  results: DbResultSet[]
  messages: string[]
  /** rows inserted / updated / deleted; -1 for none */
  affected: number
  ms: number
}

/* ---------------- Zalo (Zalo tab + Claude's zalo tools) ---------------- */

export interface ZaloState {
  status: 'off' | 'qr' | 'connecting' | 'online' | 'error'
  /** QR code to scan (data: URL) while status is 'qr' */
  qr?: string
  /** name shown on the phone that scanned the QR, waiting for "Đăng nhập" there */
  scanned?: string
  error?: string
  self?: { id: string; name: string; avatar: string }
}

export interface ZaloThread {
  id: string
  group: boolean
  name: string
  lastTs: number
  last: string
  avatar?: string
  /** incoming messages not read here yet */
  unread?: number
  /** pinned in Zalo */
  pinned?: boolean
  /** groups: member count */
  members?: number
  /** the last message was sent by me, and its delivery state */
  lastSelf?: boolean
  lastStatus?: ZaloMessage['status']
  /** a friend shown from the contact list, no message synced yet */
  contact?: boolean
}

export type ZaloAttachKind = 'photo' | 'video' | 'voice' | 'file' | 'sticker' | 'gif' | 'link' | 'location' | 'card' | 'other'

export interface ZaloAttachment {
  kind: ZaloAttachKind
  url?: string
  thumb?: string
  title?: string
  desc?: string
  width?: number
  height?: number
  /** bytes */
  size?: number
  /** seconds */
  duration?: number
  ext?: string
  sticker?: { id: number; cateId: number; type: number }
}

export interface ZaloMessage {
  id: string
  cliMsgId: string
  threadId: string
  group: boolean
  fromId: string
  fromName: string
  self: boolean
  ts: number
  /** Zalo msgType, e.g. "webchat", "chat.photo" */
  type: string
  /** readable text: the message, or "[kind] title url" for attachments */
  text: string
  /** "Sender: quoted text" (for Claude's tools) */
  quote?: string
  /** the message this one replies to */
  reply?: { id: string; from: string; text: string }
  att?: ZaloAttachment
  mentions?: { uid: string; pos: number; len: number }[]
  /** reaction icon (Zalo code, e.g. "/-heart") → user ids */
  reactions?: Record<string, string[]>
  recalled?: boolean
  /** my messages: sent, or read by the other side */
  status?: 'sending' | 'sent' | 'seen' | 'failed'
  /** what Zalo needs to quote this message / mark it seen */
  raw?: { content: unknown; msgType: string; propertyExt?: unknown; uidFrom: string; idTo: string; ttl: number; st: number; at: number; cmd: number }
}

export interface ZaloSticker {
  id: number
  cateId: number
  type: number
  url: string
}

/** header / info panel details of a conversation */
export interface ZaloThreadInfo {
  id: string
  name: string
  avatar?: string
  group: boolean
  members?: number
  desc?: string
  /** users: ms timestamp of last activity, 0 = online now, undefined = hidden */
  lastOnline?: number
  online?: boolean
  phone?: string
}

export interface ZaloTyping {
  threadId: string
  uid: string
  name: string
}
