import { clearAttachments } from './attachments'
import { basename, uid, useStore, type Chat, type EditorTab, type WebTab } from './store'
import { createTerm, disposeTerm, focusTerm, onTerminalEvents, readScreen, restartTerm, setTerminalClear, setTerminalTheme, writeToTerm } from './terminals'
import { disposeModel, getModel, isDirty } from './fileModels'
import type { SessionInfo } from '../../shared/types'

const st = useStore.getState
const lastData = new Map<string, number>()

/* ---------------- Activity tracking: infer chat status from PTY output ---------------- */

/**
 * Claude Code redraws its screen even while idle (cursor, hints, focus), so "output arrived" isn't
 * "working". It shows "esc to interrupt" in its footer exactly while it is busy — use that.
 */
const statusTimer = new Map<string, ReturnType<typeof setTimeout>>()
function checkStatus(id: string): void {
  clearTimeout(statusTimer.get(id))
  statusTimer.set(
    id,
    setTimeout(() => {
      statusTimer.delete(id)
      const chat = st().chats.find((c) => c.id === id)
      if (!chat || chat.status === 'exited') return
      const busy = /esc to interrupt/i.test(readScreen(id).split('\n').slice(-8).join('\n'))
      if (busy && chat.status !== 'working') st().patchChat(id, { status: 'working' })
      if (!busy && chat.status !== 'idle') {
        // finished work while you were looking elsewhere → needs a look
        st().patchChat(id, { status: 'idle', attention: chat.status === 'working' && id !== st().activeChatId })
      }
    }, 200)
  )
}

onTerminalEvents({
  activity: (id) => {
    lastData.set(id, Date.now())
    if (st().chats.some((c) => c.id === id)) checkStatus(id)
  },
  title: (id, raw) => {
    // Claude Code sets the terminal title to a short task summary, often prefixed by a spinner glyph.
    const title = raw.replace(/^[\s✳✶✻✽✢·*⠀-⣿]+/u, '').trim()
    if (!title || /^(claude|claude code|powershell|pwsh|windows powershell)$/i.test(title) || /\.exe$/i.test(title)) return
    const chat = st().chats.find((c) => c.id === id)
    // once the session store has a title for this chat, that one wins (see loadSessions)
    const known = chat?.sessionId && st().projects.some((g) => g.sessions.some((s) => s.id === chat.sessionId))
    if (chat && !chat.pinnedTitle && !known) st().patchChat(id, { title })
    const shell = st().shells.find((s) => s.id === id)
    if (shell) st().patchShell(id, { title })
  },
  exit: (id, code) => {
    const chat = st().chats.find((c) => c.id === id)
    // -1: you typed into a chat whose process had already died; bring it straight back
    if (chat && code === -1) {
      if (chat.status !== 'starting') restartChat(id)
      return
    }
    if (chat) st().patchChat(id, { status: 'exited' })
    if (st().shells.some((s) => s.id === id)) st().patchShell(id, { exited: true })
  },
  // Typing into an ended chat brings it back (resumes the same conversation) instead of doing nothing.
  input: (id, data) => {
    const chat = st().chats.find((c) => c.id === id)
    if (!chat || chat.status !== 'exited') return false
    // ignore focus/mouse reports the terminal sends on its own
    if (data.startsWith('\x1b[I') || data.startsWith('\x1b[O') || data.startsWith('\x1b[<')) return true
    restartChat(id)
    return true
  },
  // A link clicked in a chat opens in that chat's Web tab (from a shell: the current chat's).
  link: (id, url) => {
    const chatId = st().chats.some((c) => c.id === id) ? id : st().activeChatId
    newBrowserTab(browserKey(chatId), url)
  },
  // A local dev server showing up in a chat's output becomes that chat's Web page.
  data: (id, data) => {
    const chat = st().chats.find((c) => c.id === id)
    if (!chat) return
    // Startup prompts: the trust-folder question is always answered "Yes" (you only open your own
    // projects here); the bypass warning too when the chat or its project runs in bypass mode.
    const bypass = !!st().projectBypass[folderKey(chat.cwd)] || chat.permissionMode === 'bypassPermissions'
    answerStartupDialog(id, bypass)
    const text = ((outTail.get(id) ?? '') + data.replace(ANSI, '')).slice(-400)
    outTail.set(id, text)
    const seen = seenLocal.get(id) ?? new Set<string>()
    for (const m of text.matchAll(LOCAL_URL)) {
      const url = m[0].replace(/[.,;:]+$/, '').replace('://0.0.0.0', '://localhost')
      if (seen.has(url)) continue
      seen.add(url)
      seenLocal.set(id, seen)
      setBrowserUrl(browserKey(id), url)
    }
  }
})

/* ---------------- Bypass permissions for a whole project ---------------- */

export const folderKey = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

export async function loadProjectBypass(folder: string): Promise<void> {
  const on = await window.api.claude.getProjectBypass(folder).catch(() => false)
  useStore.setState((s) => ({ projectBypass: { ...s.projectBypass, [folderKey(folder)]: on } }))
}

/**
 * Turn bypass on/off for the chat's project: Claude Code's own per-project setting, then restart
 * that project's open chats so they pick it up.
 */
export async function toggleProjectBypass(chatId: string): Promise<void> {
  const chat = st().chats.find((c) => c.id === chatId)
  if (!chat) return
  const key = folderKey(chat.cwd)
  const on = !st().projectBypass[key]
  const msg = on
    ? `Bypass permissions for the whole project?\n\n${chat.cwd}\n\nClaude will run commands and edit files here without asking. The trust-folder and bypass warnings are answered "Yes" for you. Saved in .claude/settings.local.json, so it also applies when you run claude from a terminal.\n\nOpen chats in this project restart.`
    : `Turn off bypass for ${chat.cwd}?\n\nClaude asks for permission again. Open chats in this project restart.`
  if (!window.confirm(msg)) return
  try {
    await window.api.claude.setProjectBypass(chat.cwd, on)
  } catch (e) {
    window.alert(`Couldn't update .claude/settings.local.json in this project:\n${(e as Error).message}`)
    return
  }
  useStore.setState((s) => ({ projectBypass: { ...s.projectBypass, [key]: on } }))
  for (const c of st().chats.filter((x) => folderKey(x.cwd) === key)) {
    st().patchChat(c.id, { permissionMode: on ? 'bypassPermissions' : undefined })
    restartChat(c.id)
  }
}

const dialogTimer = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * On a bypassed project, say "Yes" to Claude Code's trust-folder / bypass-warning prompts.
 * xterm draws asynchronously, so look at the screen a moment after output settles (not inside
 * the data event), and look again after each key we send — the prompt may not redraw otherwise.
 */
function answerStartupDialog(id: string, acceptBypass: boolean, tries = 0): void {
  clearTimeout(dialogTimer.get(id))
  dialogTimer.set(
    id,
    setTimeout(() => {
      dialogTimer.delete(id)
      if (!st().chats.some((c) => c.id === id)) return
      const screen = readScreen(id)
      const yes = acceptBypass ? /Yes, I trust this folder|Yes, I accept/i : /Yes, I trust this folder/i
      if (!/Enter to confirm/i.test(screen) || !yes.test(screen)) return
      // Look only at the two option lines — other lines (your own "> message" echoes) can carry a
      // ">" too, and pressing Enter while "No, exit" is highlighted would quit Claude.
      const lines = screen.split('\n')
      const pointer = /^\s*[❯>›▶]\s/
      const yesLine = [...lines].reverse().find((l) => /Yes, I (trust this folder|accept)/i.test(l)) ?? ''
      const noLine = [...lines].reverse().find((l) => /No, exit/i.test(l)) ?? ''
      if (pointer.test(yesLine) && !pointer.test(noLine)) writeToTerm(id, '\r')
      else if (pointer.test(noLine)) writeToTerm(id, '\x1b[B')
      else return // can't tell which option is selected: leave it to you
      if (tries < 6) answerStartupDialog(id, acceptBypass, tries + 1)
    }, tries ? 450 : 250)
  )
}

/* eslint-disable no-control-regex */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(?::\d{2,5})(?:\/[^\s'"<>)\]]*)?/g
/** last bit of each chat's output (URLs can arrive split across chunks) and local URLs already used */
const outTail = new Map<string, string>()
const seenLocal = new Map<string, Set<string>>()

setInterval(() => {
  const now = Date.now()
  for (const c of st().chats) {
    if (c.status !== 'working') continue
    // quiet for a while: look at the footer again (it decides, not the silence)
    if (now - (lastData.get(c.id) ?? 0) > 1600) checkStatus(c.id)
  }
}, 500)

/* ---------------- Theme ---------------- */

/** Dark (slate-blue, the default) or light; pushes it to the page, terminals, editor and see-through. */
export function applyTheme(): void {
  const light = st().settings?.theme === 'light'
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  setTerminalTheme(light)
  if (st().themeResolved !== (light ? 'light' : 'dark')) useStore.setState({ themeResolved: light ? 'light' : 'dark' })
  applyGlass()
}

export async function toggleTheme(): Promise<void> {
  const next = st().themeResolved === 'light' ? 'dark' : 'light'
  const settings = await window.api.app.setSettings({ theme: next }).catch(() => null)
  if (settings) useStore.setState({ settings })
}

/* ---------------- See-through (Linux-style overlay) ---------------- */

const GLASS_VARS = ['--bg-0', '--bg-1', '--bg-2', '--bg-term', '--frame', '--band', '--band-2']

/**
 * In see-through mode the window itself is transparent; fade the page's backgrounds so the
 * desktop shows through while text stays fully solid. The base layer gets the chosen opacity,
 * panels on top only a tint so stacked layers don't add back up to solid. Below 50% the text
 * gets a heavier halo (data-glass-low) so it stays readable over any wallpaper.
 */
export function applyGlass(): void {
  const root = document.documentElement
  for (const v of GLASS_VARS) root.style.removeProperty(v)
  document.body.style.removeProperty('background')
  const s = st().settings
  const on = !!s?.seeThrough
  const light = root.dataset.theme === 'light'
  setTerminalClear(on)
  // a soft halo keeps text readable whatever shows through (light halo for dark text, and vice versa)
  if (on) root.dataset.glass = light ? 'light' : 'dark'
  else delete root.dataset.glass
  if (!on || !s) {
    delete root.dataset.glassLow
    return
  }
  const a = Math.min(1, Math.max(0.05, s.dropOpacity))
  if (a < 0.5) root.dataset.glassLow = ''
  else delete root.dataset.glassLow
  const cs = getComputedStyle(root)
  const read = (v: string): string => cs.getPropertyValue(v).trim()
  const base = read('--frame') || read('--bg-0')
  const mix = (c: string, k: number): string => `color-mix(in srgb, ${c} ${Math.round(Math.min(1, k) * 100)}%, transparent)`
  document.body.style.background = mix(base, a)
  // light panels need a bit more body than dark ones: dark text over a dark desktop is the hard case
  const panel = light ? 0.6 : 0.45
  // the terminal and editor are dense text drawn on a canvas (no halo possible): keep a floor
  // under them so they stay readable however see-through the rest of the window is
  const floor: Record<string, number> = light ? { '--bg-term': 0.5, '--bg-2': 0.45 } : { '--bg-term': 0.35, '--bg-2': 0.3 }
  for (const v of GLASS_VARS) {
    const c = read(v)
    if (c) root.style.setProperty(v, mix(c, Math.max(a * panel, floor[v] ?? 0)))
  }
}

useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings) applyTheme()
})

/* ---------------- Folder ---------------- */

const samePath = (a: string, b: string): boolean =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

export async function openFolder(folder?: string | null, opts: { autoChat?: boolean } = {}): Promise<void> {
  const f = folder ?? (await window.api.app.pickFolder())
  if (!f) return
  const s = await window.api.app.rememberFolder(f)
  const same = st().root && samePath(st().root!, f)
  useStore.setState({ root: f, recent: s.recentFolders, ...(same ? {} : { tabs: [], activeTabId: null, git: { isRepo: false, root: null, branch: null, files: [] } }) })
  await window.api.fs.watch(f)
  refreshGit()
  const autoChat = opts.autoChat ?? true
  if (autoChat && st().claude?.found && !st().chats.some((c) => samePath(c.cwd, f))) newChat()
}

/* ---------------- Claude session store (shared with the Claude app) ---------------- */

let sessTimer: ReturnType<typeof setTimeout> | null = null
export function loadSessions(): void {
  if (sessTimer) clearTimeout(sessTimer)
  sessTimer = setTimeout(async () => {
    const projects = await window.api.sessions.list().catch(() => null)
    if (!projects) return
    useStore.setState({ projects })
    // Titles Claude generates (or that were renamed in the Claude app) flow into open chats.
    const byId = new Map(projects.flatMap((g) => g.sessions.map((s) => [s.id, s] as const)))
    for (const c of st().chats) {
      const s = c.sessionId ? byId.get(c.sessionId) : undefined
      if (s && !c.pinnedTitle && s.title && s.title !== c.title) st().patchChat(c.id, { title: s.title })
    }
  }, 50)
}

/** Open a session from ~/.claude/projects: jump to its live chat, or resume it in a new one. */
export async function openSession(s: SessionInfo): Promise<void> {
  const live = st().chats.find((c) => c.sessionId === s.id)
  if (live) return selectChat(live.id)
  if (!s.cwdExists) {
    window.alert(`The folder for this chat no longer exists:\n${s.cwd}`)
    return
  }
  if (!st().root || !samePath(st().root!, s.projectCwd)) await openFolder(s.projectCwd, { autoChat: false })
  newChat({ cwd: s.cwd, args: ['--resume', s.id], title: s.title, sessionId: s.id, pinnedTitle: true })
}

/** New chat inside a project from the sidebar tree. */
export async function newChatIn(projectCwd: string): Promise<void> {
  if (!st().root || !samePath(st().root!, projectCwd)) await openFolder(projectCwd, { autoChat: false })
  newChat()
}

export async function detectClaude(): Promise<void> {
  const claude = await window.api.claude.detect()
  useStore.setState({ claude })
}

let gitTimer: ReturnType<typeof setTimeout> | null = null
export function refreshGit(): void {
  if (gitTimer) clearTimeout(gitTimer)
  gitTimer = setTimeout(async () => {
    const root = st().root
    if (!root) return
    const git = await window.api.git.state(root)
    useStore.setState({ git })
  }, 120)
}

/* ---------------- Chats ---------------- */

interface NewChatOpts {
  cwd?: string
  args?: string[]
  title?: string
  sessionId?: string
  pinnedTitle?: boolean
}

export function newChat(opts: NewChatOpts = {}): void {
  const cwd = opts.cwd ?? st().root
  if (!cwd) return
  let args = opts.args ?? []
  let sessionId = opts.sessionId
  // Fresh chats get an id we choose, so the sidebar can match them to the session store.
  if (!sessionId && !args.some((a) => a === '--resume' || a === '--continue' || a === '-r' || a === '-c')) {
    sessionId = crypto.randomUUID()
    args = [...args, '--session-id', sessionId]
  }
  // New chats always start the same way, whatever an earlier chat picked.
  const model = NEW_CHAT_DEFAULTS.model
  const effort = NEW_CHAT_DEFAULTS.effort
  const permissionMode = NEW_CHAT_DEFAULTS.permissionMode
  args = [...args, ...launchFlags({ model, effort, permissionMode })]
  const n = st().chats.length + 1
  const chat: Chat = {
    id: 'chat-' + uid(),
    title: opts.title ?? `Chat ${n}`,
    pinnedTitle: opts.pinnedTitle ?? false,
    cwd,
    status: 'starting',
    attention: false,
    createdAt: Date.now(),
    claudeArgs: args,
    sessionId,
    model,
    effort,
    permissionMode
  }
  createTerm({ id: chat.id, cwd: chat.cwd, kind: 'claude', claudeArgs: args })
  useStore.setState((s) => ({ chats: [...s.chats, chat], activeChatId: chat.id }))
}

/** What every new chat starts with: Opus 5.5, medium effort, bypass permissions. */
const NEW_CHAT_DEFAULTS = { model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'bypassPermissions' }

/** CLI flags that carry a chat's model, effort and permission mode across (re)starts. */
function launchFlags(c: { model?: string; effort?: string; permissionMode?: string }): string[] {
  const out: string[] = []
  if (c.model) out.push('--model', c.model)
  if (c.effort) out.push('--effort', c.effort)
  if (c.permissionMode) out.push('--permission-mode', c.permissionMode)
  return out
}

/** Switch model live (`/model`) for this chat. */
export function setChatModel(id: string, model: string): void {
  writeToTerm(id, `/model ${model || 'default'}\r`)
  st().patchChat(id, { model: model || undefined })
  focusTerm(id)
}

/** Switch reasoning effort live (`/effort`) for this chat. */
export function setChatEffort(id: string, effort: string): void {
  writeToTerm(id, `/effort ${effort || 'auto'}\r`)
  st().patchChat(id, { effort: effort || undefined })
  focusTerm(id)
}

/** Permission mode is a launch flag: resume the same conversation with the new mode. */
export function setChatPermission(id: string, mode: string): void {
  const c = st().chats.find((x) => x.id === id)
  if (!c) return
  if (c.status === 'working' && !window.confirm('Claude is still working. Restart this chat with the new permission mode?')) return
  st().patchChat(id, { permissionMode: mode || undefined })
  restartChat(id)
}

export function selectChat(id: string): void {
  const chat = st().chats.find((c) => c.id === id)
  useStore.setState({ activeChatId: id })
  st().patchChat(id, { attention: false })
  // Explorer / Changes follow the chat you're looking at.
  if (chat) {
    const proj = st().projects.find((g) => g.sessions.some((s) => s.id === chat.sessionId))
    const folder = proj?.cwd ?? chat.cwd
    if (st().root && !samePath(st().root!, folder) && !samePath(st().root!, chat.cwd)) openFolder(folder, { autoChat: false })
  }
  setTimeout(() => focusTerm(id), 0)
}

export function closeChat(id: string): void {
  disposeTerm(id)
  clearAttachments(id)
  lastData.delete(id)
  useStore.setState((s) => {
    const idx = s.chats.findIndex((c) => c.id === id)
    const chats = s.chats.filter((c) => c.id !== id)
    const activeChatId =
      s.activeChatId === id ? (chats[Math.min(idx, chats.length - 1)]?.id ?? null) : s.activeChatId
    // the chat's browser page goes with it
    const browsers = { ...s.browsers }
    delete browsers[id]
    return { chats, activeChatId, browsers }
  })
}

export function restartChat(id: string): void {
  const c = st().chats.find((x) => x.id === id)
  if (!c) return
  st().patchChat(id, { status: 'starting' })
  // a chat that never got past startup has nothing to resume: start that same session fresh
  const saved = !!c.sessionId && st().projects.some((g) => g.sessions.some((s) => s.id === c.sessionId))
  const base = c.sessionId ? (saved ? ['--resume', c.sessionId] : ['--session-id', c.sessionId]) : ['--continue']
  restartTerm(id, { claudeArgs: [...base, ...launchFlags(c)] })
}

export function renameChat(id: string, title: string): void {
  const t = title.trim()
  if (t) st().patchChat(id, { title: t, pinnedTitle: true })
}

/* ---------------- Shells (bottom panel) ---------------- */

export function newShell(): void {
  const root = st().root
  if (!root) return
  const id = 'sh-' + uid()
  createTerm({ id, cwd: root, kind: 'shell' })
  useStore.setState((s) => ({
    shells: [...s.shells, { id, title: 'terminal', cwd: root, exited: false }],
    activeShellId: id,
    bottomOpen: true
  }))
}

export function closeShell(id: string): void {
  disposeTerm(id)
  useStore.setState((s) => {
    const shells = s.shells.filter((x) => x.id !== id)
    return {
      shells,
      activeShellId: s.activeShellId === id ? (shells[shells.length - 1]?.id ?? null) : s.activeShellId,
      bottomOpen: shells.length > 0 && s.bottomOpen
    }
  })
}

export function toggleBottom(): void {
  const s = st()
  if (!s.bottomOpen && s.shells.length === 0) return newShell()
  useStore.setState({ bottomOpen: !s.bottomOpen })
}

/* ---------------- Editor tabs ---------------- */

function pushTab(tab: EditorTab): void {
  useStore.setState((s) => {
    if (s.tabs.some((t) => t.id === tab.id)) return { activeTabId: tab.id, centerView: 'code' }
    return { tabs: [...s.tabs, tab], activeTabId: tab.id, centerView: 'code' }
  })
}

export function openFile(path: string): void {
  pushTab({ id: 'f:' + path.toLowerCase(), kind: 'file', path, title: basename(path), dirty: false })
}

export const HOME_URL = 'about:blank'

/** Browser key for the chat you're looking at — every chat keeps its own page. */
export const browserKey = (activeChatId: string | null): string => activeChatId ?? '_'

const blankTab = (url = HOME_URL): WebTab => ({ id: 'w-' + uid(), url, title: '' })

/** Show the Web tab for the current chat (optionally at a URL, in the tab you're on). */
export function openBrowser(url?: string): void {
  const key = browserKey(st().activeChatId)
  if (!st().browsers[key]) newBrowserTab(key, url)
  else if (url) setBrowserUrl(key, url)
  useStore.setState({ centerView: 'web' })
}

/** A new tab in a chat's browser (reuses the open tab when it's still blank), and show it. */
export function newBrowserTab(key: string, url?: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    const cur = b?.tabs.find((t) => t.id === b.active)
    if (b && cur && cur.url === HOME_URL) {
      if (!url) return { centerView: 'web' }
      return { centerView: 'web', browsers: { ...s.browsers, [key]: { ...b, tabs: b.tabs.map((t) => (t === cur ? { ...t, url } : t)) } } }
    }
    const tab = blankTab(url)
    return { centerView: 'web', browsers: { ...s.browsers, [key]: { tabs: [...(b?.tabs ?? []), tab], active: tab.id } } }
  })
}

export function selectBrowserTab(key: string, id: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    return b && b.active !== id ? { browsers: { ...s.browsers, [key]: { ...b, active: id } } } : s
  })
}

/** Close one tab; closing the last one leaves a blank tab. */
export function closeBrowserTab(key: string, id: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    if (!b) return s
    const idx = b.tabs.findIndex((t) => t.id === id)
    let tabs = b.tabs.filter((t) => t.id !== id)
    if (tabs.length === 0) tabs = [blankTab()]
    const active = b.active === id ? tabs[Math.min(idx, tabs.length - 1)].id : b.active
    return { browsers: { ...s.browsers, [key]: { tabs, active } } }
  })
}

/** A chat's Claude used its browser tools: give that chat a Web tab, and show it if it's the open chat. */
export function showChatBrowser(chatId: string): void {
  useStore.setState((s) => {
    const browsers = s.browsers[chatId] ? s.browsers : { ...s.browsers, [chatId]: (() => { const t = blankTab(); return { tabs: [t], active: t.id } })() }
    return { browsers, centerView: chatId === s.activeChatId ? 'web' : s.centerView }
  })
}

/** Point a tab (default: the chat's open tab) at a URL / record its title. */
export function setBrowserUrl(key: string, url: string, tabId?: string, title?: string): void {
  useStore.setState((s) => {
    const b = s.browsers[key]
    if (!b) {
      const t = blankTab(url)
      return { browsers: { ...s.browsers, [key]: { tabs: [t], active: t.id } } }
    }
    const id = tabId ?? b.active
    const cur = b.tabs.find((t) => t.id === id)
    if (!cur || (cur.url === url && (title === undefined || cur.title === title))) return s
    const tabs = b.tabs.map((t) => (t === cur ? { ...t, url, title: title ?? t.title } : t))
    return { browsers: { ...s.browsers, [key]: { ...b, tabs } } }
  })
}

export function openDiff(abs: string, rel: string): void {
  pushTab({ id: 'd:' + abs.toLowerCase(), kind: 'diff', path: abs, rel, title: basename(abs) })
}

/** A file as one commit changed it (commit vs its parent). */
export function openCommitDiff(gitRoot: string, commit: { hash: string; short: string; subject: string }, rel: string): void {
  const abs = gitRoot.replace(/[\\/]+$/, '') + '/' + rel
  pushTab({ id: `c:${commit.hash}:${rel}`, kind: 'diff', path: abs, rel, title: `${basename(rel)} @${commit.short}`, commit })
}

export function closeTab(id: string): void {
  const tab = st().tabs.find((t) => t.id === id)
  if (tab?.kind === 'file') {
    const m = getModel(tab.path)
    if (m && isDirty(m) && !window.confirm(`Discard unsaved changes to ${tab.title}?`)) return
    disposeModel(tab.path)
  }
  useStore.setState((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id)
    const tabs = s.tabs.filter((t) => t.id !== id)
    const activeTabId = s.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTabId
    return { tabs, activeTabId }
  })
}
