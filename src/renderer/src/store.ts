import { create } from 'zustand'
import type { AppSettings, ClaudeInfo, GitState, ProjectGroup, WindowState } from '../../shared/types'

export type ChatStatus = 'starting' | 'working' | 'idle' | 'exited'

export interface Chat {
  id: string
  title: string
  /** true once the user renamed it — stop following the terminal title */
  pinnedTitle: boolean
  cwd: string
  status: ChatStatus
  /** finished work while you were looking elsewhere */
  attention: boolean
  createdAt: number
  claudeArgs?: string[]
  /** Claude Code session id — links this chat to its entry in ~/.claude/projects */
  sessionId?: string
  model?: string
  effort?: string
  permissionMode?: string
}

export interface ShellTab {
  id: string
  title: string
  cwd: string
  exited: boolean
}

export type EditorTab =
  | { id: string; kind: 'file'; path: string; title: string; dirty: boolean }
  /** commit set: that commit vs its parent; otherwise working tree vs HEAD */
  | { id: string; kind: 'diff'; path: string; rel: string; title: string; commit?: { hash: string; short: string; subject: string } }

export type SidebarView = 'chats' | 'explorer' | 'changes'

interface State {
  root: string | null
  recent: string[]
  claude: ClaudeInfo | null
  git: GitState
  fsTick: number
  /** every project + session Claude Code knows about (shared with the Claude app) */
  projects: ProjectGroup[]
  win: WindowState | null
  settings: AppSettings | null
  /** theme actually showing (system preference resolved) */
  themeResolved: 'light' | 'dark' | 'blue'

  sidebarView: SidebarView
  sidebarOpen: boolean
  bottomOpen: boolean
  quickOpen: boolean

  chats: Chat[]
  activeChatId: string | null

  shells: ShellTab[]
  activeShellId: string | null

  tabs: EditorTab[]
  activeTabId: string | null
  diffSideBySide: boolean

  /** middle area: the code editor or the built-in browser */
  centerView: 'code' | 'web'
  /** each chat has its own browser tabs: chat id ('_' with no chat open) → its tabs */
  browsers: Record<string, ChatBrowser>
  /** project folder (lower-cased, no trailing slash) → Claude runs it in bypass-permissions mode */
  projectBypass: Record<string, boolean>

  set: (p: Partial<State>) => void
  patchChat: (id: string, p: Partial<Chat>) => void
  patchShell: (id: string, p: Partial<ShellTab>) => void
}

/** One tab of the built-in browser. */
export interface WebTab {
  id: string
  url: string
  title: string
}
export interface ChatBrowser {
  tabs: WebTab[]
  active: string
}

export const useStore = create<State>((set) => ({
  root: null,
  recent: [],
  claude: null,
  git: { isRepo: false, root: null, branch: null, files: [] },
  fsTick: 0,
  projects: [],
  win: null,
  settings: null,
  themeResolved: 'dark',

  sidebarView: 'chats',
  sidebarOpen: true,
  bottomOpen: false,
  quickOpen: false,

  chats: [],
  activeChatId: null,

  shells: [],
  activeShellId: null,

  tabs: [],
  activeTabId: null,
  diffSideBySide: true,

  centerView: 'code',
  browsers: {},
  projectBypass: {},

  set: (p) => set(p),
  patchChat: (id, p) => set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, ...p } : c)) })),
  patchShell: (id, p) => set((s) => ({ shells: s.shells.map((c) => (c.id === id ? { ...c, ...p } : c)) }))
}))

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

export const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export const fileUri = (p: string): string => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '')
