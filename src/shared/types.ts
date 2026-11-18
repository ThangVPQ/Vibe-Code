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
  /** extra args for claude, e.g. ['--continue'] or ['--resume', id] */
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

export interface ClaudeInfo {
  found: boolean
  path: string | null
  shell: string
}
