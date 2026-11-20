import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Collapse, SlidePill } from './motion'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  FolderGit2,
  FolderPlus,
  History,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
  ChevronsDownUp,
  Copy,
  ExternalLink,
  FolderOpen,
  GitCommitHorizontal,
  GitBranch,
  Link2,
  Search,
  MessageSquare,
  Pencil,
  Plus,
  FilePlus,
  FileText,
  Scissors,
  ClipboardPaste,
  CopyPlus,
  Trash2,
  Undo2,
  FileDiff
} from 'lucide-react'
import { basename, useStore, type Chat, type EditorTab } from '../store'
import {
  closeChat,
  closeTab,
  defaultAgent,
  loadSessions,
  openFolder,
  newChat,
  newChatIn,
  openCommitDiff,
  openDiff,
  openFile,
  openSession,
  refreshGit,
  renameChat,
  restartChat,
  selectChat
} from '../actions'
import { hasUnsaved } from '../fileModelsLite'
import { openMenu } from './ContextMenu'
import { FileIcon, FolderIcon, StatusDot, statusLabel } from './icons'
import type { DirEntry, GitBranch as GitBranchInfo, GitCommit, GitCommitFile, GitFile, ProjectGroup, SessionInfo } from '../../../shared/types'
import { agentDef } from '../../../shared/agents'
import { NewChatMenu } from './AgentMenu'
import { ZaloSideGroup } from './zalo/ZaloSide'

export function Sidebar(): React.JSX.Element {
  // files and git changes live in the Source code tab; the sidebar is just the chats
  return (
    <div className="sidebar">
      <ChatsView />
    </div>
  )
}

function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="section-header">
      <span>{title}</span>
      <div className="section-actions">{children}</div>
    </div>
  )
}

/* ================================ Chats ================================ */

function useTick(ms: number): void {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

const normKey = (p: string): string => p.toLowerCase().replace(/[\\/]+$/, '')

function ChatsView(): React.JSX.Element {
  useTick(30000)
  // New chat lives on the + of each project (and Ctrl+Shift+N), so the list starts right away
  const disabled = !useStore((s) => !!s.claude?.found || s.agents.some((a) => a.found))
  return (
    <>
      <div className="scroll">
        <ProjectsTree />
      </div>
      <div className="sidebar-foot">
        <button
          className="btn btn-primary btn-block"
          disabled={disabled}
          title="Pick (or make) a folder and start a chat in it"
          onClick={() => openFolder(null, { autoChat: true })}
        >
          <FolderPlus size={15} /> New project
        </button>
      </div>
    </>
  )
}

const EXPANDED_KEY = 'tinjs.expandedProjects'
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

const PAGE = 8

const RECENT_MAX = 5

interface RecentItem {
  key: string
  title: string
  project: string
  updated: number
  /** open in this window */
  chat?: Chat
  /** in Claude's history (resumable) */
  session?: SessionInfo
}

/** A row of Recent; plain props, so it skips re-rendering while nothing about it changed. */
const RecentRow = memo(function RecentRow(props: {
  title: string
  project: string
  updated: number
  chatId?: string
  status?: Chat['status']
  attention?: boolean
  session?: SessionInfo
  active: boolean
}): React.JSX.Element {
  const { title, project, updated, chatId, status, attention, session, active } = props
  return (
    <div
      className={`sess-row${active ? ' active' : ''}`}
      onClick={() => (chatId ? selectChat(chatId) : session && void openSession(session))}
      onContextMenu={(e) => chatMenu(e, { chatId, session })}
      title={`${title}\n${project} · ${new Date(updated).toLocaleString()}`}
    >
      {status ? <StatusDot status={status} attention={attention} /> : <span className="sess-bullet" />}
      <span className="sess-title">{title}</span>
      <span className="sess-time">{shortAgo(updated)}</span>
    </div>
  )
})

/** The newest chats of every project: open ones not in the history yet, then the history. */
function recentItems(projects: ProjectGroup[], chats: Chat[]): RecentItem[] {
  const live = new Map(chats.filter((c) => c.sessionId).map((c) => [c.sessionId!, c]))
  const history: RecentItem[] = projects.flatMap((g) =>
    g.sessions.map((s) => {
      const chat = live.get(s.id)
      return { key: s.id, title: chat?.pinnedTitle ? chat.title : s.title || chat?.title || 'Chat', project: g.name, updated: s.updated, chat, session: s }
    })
  )
  const known = new Set(history.map((r) => r.key))
  const fresh: RecentItem[] = chats
    .filter((c) => !c.sessionId || !known.has(c.sessionId))
    .map((c) => ({ key: c.id, title: c.title, project: basename(c.cwd), updated: c.createdAt, chat: c }))
  return [...fresh, ...history].sort((a, b) => b.updated - a.updated).slice(0, RECENT_MAX)
}

/** Every project + conversation from Claude Code's store — the same list the Claude app shows. */
function ProjectsTree(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const root = useStore((s) => s.root)
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [more, setMore] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')

  // the project you're in starts open
  useEffect(() => {
    if (!root) return
    const key = normKey(root)
    setExpanded((e) => (e.has(key) ? e : new Set(e).add(key)))
  }, [root])

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]))
    } catch {
      /* storage unavailable */
    }
  }, [expanded])

  const liveBySession = useMemo(() => new Map(chats.filter((c) => c.sessionId).map((c) => [c.sessionId!, c])), [chats])
  const activeSession = chats.find((c) => c.id === activeChatId)?.sessionId

  // Open chats the session store doesn't list (yet) go under their project, adding the project when
  // it has no Claude history: Codex / Grok / Gemini… chats, and new Claude chats until Claude writes
  // their transcript (only after the first message; a missed file event could delay it further).
  const slashKey = (p: string): string => normKey(p).replace(/\//g, '\\')
  const known = useMemo(() => new Set(projects.flatMap((g) => g.sessions.map((s) => s.id))), [projects])
  const agentChats = chats.filter((c) => agentDef(c.agent).id !== 'claude' || (!!c.sessionId && !known.has(c.sessionId)))
  const allProjects: ProjectGroup[] = [...projects]
  for (const c of agentChats) {
    if (allProjects.some((g) => slashKey(g.key) === slashKey(c.cwd))) continue
    allProjects.unshift({ key: normKey(c.cwd), cwd: c.cwd, name: basename(c.cwd), updated: c.createdAt, sessions: [] })
  }
  const needle = q.trim().toLowerCase()
  // Opening a chat touches its transcript (resume, focus…), which would jump it to the top under
  // the cursor. Rows already listed keep their place; only chats newly entering the top 5 go first.
  // A row is known by its session id and, once open, its chat id too: resuming a session or a new
  // chat getting its session id must not count as a new entry.
  const recentOrder = useRef(new Map<string, number>())
  const recent = useMemo(() => {
    const prev = recentOrder.current
    const ids = (it: RecentItem): string[] => [it.key, it.session?.id, it.chat?.id, it.chat?.sessionId].filter((x): x is string => !!x)
    const pos = (it: RecentItem): number | undefined => ids(it).map((k) => prev.get(k)).find((p) => p !== undefined)
    const top = recentItems(projects, chats)
    const kept = top.filter((it) => pos(it) !== undefined).sort((a, b) => pos(a)! - pos(b)!)
    const rows = [...top.filter((it) => pos(it) === undefined), ...kept]
    recentOrder.current = new Map(rows.flatMap((it, i) => ids(it).map((k) => [k, i] as const)))
    return rows
  }, [projects, chats])
  const agentRows = (g: ProjectGroup): typeof agentChats =>
    agentChats.filter(
      (c) => slashKey(c.cwd) === slashKey(g.key) && (!needle || g.name.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle))
    )
  const visible = needle
    ? allProjects
        .map((g) => ({
          ...g,
          sessions: g.name.toLowerCase().includes(needle) ? g.sessions : g.sessions.filter((s) => s.title.toLowerCase().includes(needle))
        }))
        .filter((g) => g.sessions.length > 0 || agentRows(g).length > 0)
    : allProjects

  const flip = (set: (f: (s: Set<string>) => Set<string>) => void, key: string): void =>
    set((e) => {
      const n = new Set(e)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  return (
    <div className="side-group">
      <SlidePill selector=".sess-row.active" className="sess-pill" />
      <div className="side-group-label">
        Projects
        <span className="sync-pill" title="Read live from ~/.claude/projects — the same store the Claude app uses">
          <Link2 size={10} /> Claude
        </span>
        <button className="icon-btn tiny" title="Refresh" onClick={() => loadSessions()}>
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="tree-filter">
        <Search size={12} />
        <input placeholder="Filter chats…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
      </div>

      {/* the 5 newest chats across every project */}
      {!needle && recent.length > 0 && (
        <div className="proj recent-group">
          <div className="proj-row recent-head">
            <span className="proj-name">Recent</span>
          </div>
          {recent.map((it) => (
            <RecentRow
              key={it.key}
              title={it.title}
              project={it.project}
              updated={it.updated}
              chatId={it.chat?.id}
              status={it.chat?.status}
              attention={it.chat?.attention}
              session={it.session}
              active={!!it.chat && it.chat.id === activeChatId}
            />
          ))}
        </div>
      )}
      <ZaloSideGroup filter={q} />
      <div className="agent-groups-sep" />

      {visible.length === 0 && <div className="tree-empty">{projects.length ? 'No matching chats' : 'No Claude Code history found yet.'}</div>}

      {visible.map((g) => {
        const open = needle ? true : expanded.has(g.key)
        const isRoot = !!root && normKey(root) === g.key
        const others = agentRows(g)
        const liveCount = g.sessions.filter((s) => liveBySession.has(s.id)).length + others.length
        const shown = needle || more.has(g.key) ? g.sessions : g.sessions.slice(0, PAGE)
        return (
          <div key={g.key} className="proj">
            <div className={`proj-row${isRoot ? ' current' : ''}`} onClick={() => flip(setExpanded, g.key)} onContextMenu={(e) => projectMenu(e, g)} title={g.cwd}>
              <span className="proj-name">{g.name}</span>
              <ChevronRight size={13} className={`proj-chev${open ? ' open' : ''}`} />
              {liveCount > 0 && <span className="proj-live" title={`${liveCount} open`} />}
              <span className="proj-spacer" />
              <NewChatMenu
                className="icon-btn tiny proj-add"
                size={14}
                title={`New chat in ${g.name} — right-click to pick another AI`}
                onPick={(agent) => newChatIn(g.cwd, agent)}
              />
            </div>
            <Collapse open={open}>
            {others.map((c) => (
              <div
                key={c.id}
                className={`sess-row${c.id === activeChatId ? ' active' : ''}`}
                onClick={() => selectChat(c.id)}
                onContextMenu={(e) => chatMenu(e, { chatId: c.id })}
                title={`${c.title}\n${agentDef(c.agent).label} · ${c.cwd}`}
              >
                <StatusDot status={c.status} attention={c.attention} />
                <span className="sess-title">{c.title}</span>
                <span className="sess-time">{agentDef(c.agent).id === 'claude' ? shortAgo(c.createdAt) : agentDef(c.agent).label}</span>
              </div>
            ))}
            {shown.map((s) => {
              const live = liveBySession.get(s.id)
              return <SessRow key={s.id} s={s} active={activeSession === s.id} status={live?.status} attention={live?.attention} />
            })}
            {!needle && g.sessions.length > PAGE && (
              <button className="sess-more" onClick={() => flip(setMore, g.key)}>
                {more.has(g.key) ? 'Show less' : `Show ${g.sessions.length - PAGE} more`}
              </button>
            )}
            </Collapse>
          </div>
        )
      })}
    </div>
  )
}

/**
 * One conversation under its project. Memoized: the tree re-renders on every sessions ping while a
 * chat works; rows whose session object loadSessions kept (unchanged) skip it.
 */
const SessRow = memo(function SessRow(props: { s: SessionInfo; active: boolean; status?: Chat['status']; attention?: boolean }): React.JSX.Element {
  const { s, active, status, attention } = props
  return (
    <div
      className={`sess-row${active ? ' active' : ''}${s.cwdExists ? '' : ' gone'}`}
      onClick={() => openSession(s)}
      onContextMenu={(e) => chatMenu(e, { session: s })}
      title={`${s.title}\n${s.cwd}\nUpdated ${new Date(s.updated).toLocaleString()}`}
    >
      {status ? <StatusDot status={status} attention={attention} /> : <span className="sess-bullet" />}
      <span className="sess-title">{s.title}</span>
      <span className="sess-time">{shortAgo(s.updated)}</span>
    </div>
  )
})

/** Right-click on a chat in the sidebar: an open chat (`chatId`) and/or a session from the history. */
export function chatMenu(e: React.MouseEvent, ref: { chatId?: string; session?: SessionInfo }): void {
  const chats = useStore.getState().chats
  const chat = chats.find((c) => c.id === ref.chatId) ?? (ref.session ? chats.find((c) => c.sessionId === ref.session!.id) : undefined)
  const s = ref.session
  const title = chat?.title ?? s?.title ?? 'Chat'
  const cwd = chat?.cwd ?? s?.cwd
  const sessionId = chat?.sessionId ?? s?.id
  openMenu(e, [
    { label: 'Open', icon: <MessageSquare size={14} />, action: () => (chat ? selectChat(chat.id) : s && openSession(s)) },
    chat && {
      label: 'Rename…',
      icon: <Pencil size={14} />,
      action: () => {
        const t = window.prompt('Rename chat', chat.title)
        if (t !== null) renameChat(chat.id, t)
      }
    },
    chat?.status === 'exited' && { label: 'Restart', icon: <RotateCcw size={14} />, action: () => restartChat(chat.id) },
    chat && { label: 'Close chat', icon: <X size={14} />, action: () => closeChat(chat.id) },
    'sep',
    { label: 'Copy title', icon: <Copy size={14} />, action: () => navigator.clipboard.writeText(title) },
    !!sessionId && { label: 'Copy session ID', icon: <Copy size={14} />, action: () => navigator.clipboard.writeText(sessionId) },
    !!cwd && { label: 'Open folder in File Explorer', icon: <FolderOpen size={14} />, action: () => window.api.fs.openPath(cwd) },
    'sep',
    {
      label: 'Delete chat…',
      icon: <Trash2 size={14} />,
      hint: 'to Recycle Bin',
      action: async () => {
        const working = chat?.status === 'working' ? `\n\n${agentDef(chat.agent).label} is still working — it will be stopped.` : ''
        if (!window.confirm(`Delete chat "${title}"?\nIts history goes to the Recycle Bin.${working}`)) return
        if (chat) {
          closeChat(chat.id)
          // let the process exit first, or its last write would bring the transcript back
          await new Promise((r) => setTimeout(r, 800))
        }
        // a chat that never sent a message has no saved history
        const saved = !!sessionId && useStore.getState().projects.some((g) => g.sessions.some((x) => x.id === sessionId))
        if (saved) await window.api.sessions.remove(sessionId).catch((err) => window.alert(String(err)))
        loadSessions()
      }
    }
  ])
}

/** Right-click on a project in the sidebar. */
function projectMenu(e: React.MouseEvent, g: ProjectGroup): void {
  const agent = defaultAgent()
  openMenu(e, [
    !!agent && { label: 'New chat', icon: <Plus size={14} />, action: () => newChatIn(g.cwd, agent) },
    { label: 'Open as workspace', icon: <FolderGit2 size={14} />, action: () => openFolder(g.cwd, { autoChat: false }) },
    'sep',
    { label: 'Open folder in File Explorer', icon: <FolderOpen size={14} />, action: () => window.api.fs.openPath(g.cwd) },
    { label: 'Copy path', icon: <Copy size={14} />, action: () => navigator.clipboard.writeText(g.cwd) }
  ])
}

/** "now", "5m", "3h", "2d", then the date. */
export function shortAgo(t: number): string {
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/* ================================ Explorer ================================ */

function useGitDecorations(): Map<string, GitFile['status']> {
  // only paths + statuses matter here; +/- counts change on every edit Claude makes, and a new map
  // re-rendered the whole tree each time
  const sig = useStore((s) => s.git.files.map((f) => f.status + f.abs).join('\n'))
  return useMemo(() => {
    const m = new Map<string, GitFile['status']>()
    const files = useStore.getState().git.files
    for (const f of files) {
      const abs = f.abs.replace(/\\/g, '/').toLowerCase()
      m.set(abs, f.status)
      // bubble up to parent folders
      let p = abs
      while (p.includes('/')) {
        p = p.slice(0, p.lastIndexOf('/'))
        if (!m.has(p)) m.set(p, 'M')
      }
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}

export function ExplorerView(): React.JSX.Element | null {
  const root = useStore((s) => s.root)
  const [collapseKey, setCollapseKey] = useState(0)
  const deco = useGitDecorations()
  if (!root) return null
  return <ExplorerTree root={root} collapseKey={collapseKey} setCollapseKey={setCollapseKey} deco={deco} />
}

type OpenCtx = (e: React.MouseEvent, path: string, isDir: boolean) => void

function ExplorerTree(props: { root: string; collapseKey: number; setCollapseKey: (f: (k: number) => number) => void; deco: Map<string, string> }): React.JSX.Element {
  const { root, collapseKey, setCollapseKey, deco } = props
  // stable, so the memoized tree nodes don't all re-render with this one
  const openCtx = useCallback<OpenCtx>((e, path, isDir) => explorerMenu(e, path, isDir, root), [root])
  return (
    <>
      <SectionHeader title="Explorer">
        <button className="icon-btn" title="New file" onClick={fsOp(() => createIn(root, false))}>
          <FilePlus size={14} />
        </button>
        <button className="icon-btn" title="New folder" onClick={fsOp(() => createIn(root, true))}>
          <FolderPlus size={14} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => useStore.setState((s) => ({ fsTick: s.fsTick + 1 }))}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn" title="Collapse all" onClick={() => setCollapseKey((k) => k + 1)}>
          <ChevronsDownUp size={14} />
        </button>
      </SectionHeader>
      <div className="tree-root-label" onContextMenu={(e) => openCtx(e, root, true)}>
        {basename(root)}
      </div>
      {/* empty space below the files: the project folder's menu */}
      <div className="scroll tree" key={collapseKey} onContextMenu={(e) => openCtx(e, root, true)}>
        <DirChildren dir={root} depth={0} deco={deco} openCtx={openCtx} />
      </div>
    </>
  )
}

/** A file or folder copied / cut in the explorer, waiting for Paste. */
let fileClip: { path: string; cut: boolean } | null = null

const sepOf = (p: string): string => (p.includes('\\') ? '\\' : '/')
const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))
const refreshTree = (): void => {
  useStore.setState((s) => ({ fsTick: s.fsTick + 1 }))
  refreshGit()
}
/** Run a file operation; a failure shows its message instead of vanishing. */
const fsOp = (f: () => Promise<unknown>) => async (): Promise<void> => {
  try {
    await f()
  } catch (err) {
    window.alert(String(err))
  }
  refreshTree()
}

/** Ask for a name, then create a file / folder in `dir` (files open in the editor). */
async function createIn(dir: string, isDir: boolean): Promise<void> {
  const name = window.prompt(isDir ? 'New folder name' : 'New file name')?.trim()
  if (!name) return
  const path = dir + sepOf(dir) + name
  await window.api.fs.create(path, isDir)
  if (!isDir) openFile(path)
}

/** Right-click on a file or folder in the explorer. */
function explorerMenu(e: React.MouseEvent, path: string, isDir: boolean, root: string): void {
  const isRoot = path === root
  const rel = path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || '.'
  const name = basename(path)
  const into = isDir ? path : dirOf(path)
  const tabs = (): EditorTab[] => {
    const lower = path.toLowerCase()
    return useStore.getState().tabs.filter((t) => t.kind === 'file' && (t.path.toLowerCase() === lower || t.path.toLowerCase().startsWith(lower + sepOf(path))))
  }
  openMenu(e, [
    !isDir && { label: 'Open', icon: <FileText size={14} />, action: () => openFile(path) },
    isDir && { label: 'New file…', icon: <FilePlus size={14} />, action: fsOp(() => createIn(path, false)) },
    isDir && { label: 'New folder…', icon: <FolderPlus size={14} />, action: fsOp(() => createIn(path, true)) },
    'sep',
    !isRoot && { label: 'Cut', icon: <Scissors size={14} />, action: () => void (fileClip = { path, cut: true }) },
    !isRoot && { label: 'Copy', icon: <Copy size={14} />, action: () => void (fileClip = { path, cut: false }) },
    {
      label: 'Paste',
      icon: <ClipboardPaste size={14} />,
      hint: fileClip ? basename(fileClip.path) : undefined,
      // what was copied here first, else files copied in Windows Explorer
      action: fsOp(async () => {
        if (fileClip?.cut) {
          const to = into + sepOf(into) + basename(fileClip.path)
          if (to.toLowerCase() !== fileClip.path.toLowerCase()) await window.api.fs.rename(fileClip.path, to)
          fileClip = null
        } else if (fileClip) await window.api.fs.copy(fileClip.path, into)
        else for (const p of await window.api.app.clipboardFiles()) await window.api.fs.copy(p, into)
      })
    },
    !isRoot && { label: 'Duplicate', icon: <CopyPlus size={14} />, action: fsOp(() => window.api.fs.copy(path, dirOf(path))) },
    'sep',
    !isRoot && {
      label: 'Rename…',
      icon: <Pencil size={14} />,
      action: fsOp(async () => {
        const next = window.prompt('Rename', name)?.trim()
        if (!next || next === name) return
        const open = tabs()
        if (open.some((t) => t.kind === 'file' && hasUnsaved(t.path)) && !window.confirm('Unsaved changes in the open file will be lost. Rename anyway?')) return
        const to = dirOf(path) + sepOf(path) + next
        await window.api.fs.rename(path, to)
        // its editor tabs follow it
        for (const t of open) closeTab(t.id)
        for (const t of open) openFile(to + t.path.slice(path.length))
      })
    },
    !isRoot && {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      hint: 'to Recycle Bin',
      action: fsOp(async () => {
        if (!window.confirm(`Move ${isDir ? 'folder' : 'file'} "${name}" to the Recycle Bin?`)) return
        await window.api.fs.trash(path)
        for (const t of tabs()) closeTab(t.id)
      })
    },
    'sep',
    isDir
      ? { label: 'Open folder in File Explorer', icon: <FolderOpen size={14} />, action: () => window.api.fs.openPath(path) }
      : { label: 'Reveal in File Explorer', icon: <FolderOpen size={14} />, action: () => window.api.fs.reveal(path) },
    { label: 'Copy path', icon: <Copy size={14} />, action: () => navigator.clipboard.writeText(path) },
    { label: 'Copy relative path', icon: <Copy size={14} />, action: () => navigator.clipboard.writeText(rel) }
  ])
}

const normDir = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Parent folder of `p`, normalized like normDir. */
const parentOf = (p: string): string => {
  const n = normDir(p)
  return n.slice(0, Math.max(0, n.lastIndexOf('/')))
}

/** Re-renders when a file event touches something directly inside `dir` (not on every change anywhere). */
function useDirChanges(dir: string): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const key = normDir(dir)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = (e: Event): void => {
      const paths = (e as CustomEvent<string[]>).detail
      if (!paths.some((p) => parentOf(p) === key)) return
      clearTimeout(timer)
      timer = setTimeout(() => setN((x) => x + 1), 100)
    }
    window.addEventListener('fs-changed', onChange)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('fs-changed', onChange)
    }
  }, [dir])
  return n
}

const sameEntries = (a: DirEntry[] | null, b: DirEntry[]): boolean =>
  !!a && a.length === b.length && a.every((x, i) => x.path === b[i].path && x.isDir === b[i].isDir && x.name === b[i].name)

function DirChildren({ dir, depth, deco, openCtx }: { dir: string; depth: number; deco: Map<string, string>; openCtx: OpenCtx }): React.JSX.Element {
  const [items, setItems] = useState<DirEntry[] | null>(null)
  // the Refresh button bumps fsTick; file events only reach the folders they touch
  const tick = useStore((s) => s.fsTick)
  const changed = useDirChanges(dir)
  useEffect(() => {
    let live = true
    window.api.fs
      .readDir(dir)
      .then((r) => live && setItems((prev) => (sameEntries(prev, r) ? prev : r)))
      .catch(() => live && setItems([]))
    return () => {
      live = false
    }
  }, [dir, tick, changed])
  if (!items) return <div className="tree-loading" style={{ paddingLeft: 12 + depth * 12 }} />
  return (
    <>
      {items.map((it) => (
        <TreeNode key={it.path} item={it} depth={depth} deco={deco} openCtx={openCtx} />
      ))}
    </>
  )
}

const TreeNode = memo(function TreeNode({ item, depth, deco, openCtx }: { item: DirEntry; depth: number; deco: Map<string, string>; openCtx: OpenCtx }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // a boolean: re-renders only when this row starts / stops being the open file
  const isActive = useStore((s) => s.activeTabId === 'f:' + item.path.toLowerCase())
  const status = deco.get(item.path.replace(/\\/g, '/').toLowerCase())
  return (
    <>
      <div
        className={`tree-row${isActive ? ' active' : ''}${status ? ` git-${status === '?' ? 'U' : status}` : ''}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        onClick={() => (item.isDir ? setOpen(!open) : openFile(item.path))}
        onContextMenu={(e) => openCtx(e, item.path, item.isDir)}
        title={item.path}
      >
        {item.isDir ? (
          <ChevronRight size={13} className={`chev${open ? ' open' : ''}`} />
        ) : (
          <span className="chev-spacer" />
        )}
        {item.isDir ? <FolderIcon open={open} /> : <FileIcon name={item.name} />}
        <span className="tree-name">{item.name}</span>
        {status && !item.isDir && <span className="tree-status">{status === '?' ? 'U' : status}</span>}
        {status && item.isDir && <span className="tree-dot" />}
      </div>
      {item.isDir && open && <DirChildren dir={item.path} depth={depth + 1} deco={deco} openCtx={openCtx} />}
    </>
  )
})

/* ================================ Changes ================================ */

/** Discard (undo) the uncommitted changes of `files`, after asking. */
async function discard(files: GitFile[], root: string): Promise<void> {
  const what = files.length === 1 ? `"${files[0].rel}"` : `all ${files.length} changed files`
  const gone = files.some((f) => f.status === '?' || f.status === 'A')
  if (!window.confirm(`Discard changes to ${what}?${gone ? '\nNew files will be deleted.' : ''}\nThis can't be undone.`)) return
  if (files.some((f) => hasUnsaved(f.abs)) && !window.confirm('A file with unsaved edits in the editor is included. Discard anyway?')) return
  const failed: string[] = []
  for (const f of files) await window.api.git.discard(root, f.rel, f.status).catch((err) => failed.push(`${f.rel}: ${err}`))
  refreshGit()
  useStore.setState((s) => ({ fsTick: s.fsTick + 1 }))
  if (failed.length) window.alert(`Couldn't discard:\n${failed.join('\n')}`)
}

/** Right-click on a changed file under Changes. */
function changeMenu(e: React.MouseEvent, f: GitFile, root: string): void {
  const all = useStore.getState().git.files
  openMenu(e, [
    { label: 'Open changes', icon: <FileDiff size={14} />, action: () => openDiff(f.abs, f.rel) },
    f.status !== 'D' && { label: 'Open file', icon: <FileText size={14} />, action: () => openFile(f.abs) },
    'sep',
    { label: 'Discard changes', icon: <Undo2 size={14} />, action: () => discard([f], root) },
    all.length > 1 && { label: 'Discard all changes…', icon: <Undo2 size={14} />, action: () => discard(all, root) },
    'sep',
    { label: 'Copy path', icon: <Copy size={14} />, action: () => navigator.clipboard.writeText(f.abs) },
    { label: 'Copy relative path', icon: <Copy size={14} />, action: () => navigator.clipboard.writeText(f.rel) },
    f.status !== 'D' && { label: 'Reveal in File Explorer', icon: <FolderOpen size={14} />, action: () => window.api.fs.reveal(f.abs) }
  ])
}

const statusName: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  U: 'Conflict',
  '?': 'Untracked',
  C: 'Copied'
}

export function ChangesView(): React.JSX.Element {
  const git = useStore((s) => s.git)
  const root = useStore((s) => s.root)!
  const activeTabId = useStore((s) => s.activeTabId)
  const totals = git.files.reduce((a, f) => ({ add: a.add + f.added, del: a.del + f.deleted }), { add: 0, del: 0 })

  if (!git.isRepo) {
    return (
      <>
        <SectionHeader title="Changes" />
        <div className="empty-state-small">
          <FolderGit2 size={30} strokeWidth={1.4} />
          <h4>Not a Git repository</h4>
          <p>Initialize Git to see exactly what Claude changes, file by file.</p>
          <button
            className="btn btn-primary"
            onClick={async () => {
              await window.api.git.init(root)
              refreshGit()
            }}
          >
            Initialize repository
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <SectionHeader title="Changes">
        <button className="icon-btn" title="Refresh" onClick={() => refreshGit()}>
          <RefreshCw size={14} />
        </button>
      </SectionHeader>
      <div className="changes-summary">
        <BranchPicker root={git.root ?? root} branch={git.branch ?? ''} />
        <div className="changes-counts">
          <span>{git.files.length} files</span>
          <span className="add">+{totals.add}</span>
          <span className="del">−{totals.del}</span>
        </div>
      </div>
      <div className="scroll">
        {git.files.length === 0 && (
          <div className="empty-hint">
            <Sparkles size={18} />
            <p>Working tree clean. Changes Claude makes will show up here instantly.</p>
          </div>
        )}
        {git.files.map((f) => {
          const name = f.rel.split('/').pop()!
          const dir = f.rel.slice(0, -name.length - 1)
          const st = f.status === '?' ? 'U' : f.status
          const active = activeTabId === 'd:' + f.abs.toLowerCase()
          return (
            <div
              key={f.rel}
              className={`change-row${active ? ' active' : ''}`}
              onClick={() => openDiff(f.abs, f.rel)}
              onContextMenu={(e) => changeMenu(e, f, git.root ?? root)}
              title={`${statusName[f.status]} — ${f.rel}`}
            >
              <FileIcon name={name} />
              <span className={`change-name${f.status === 'D' ? ' deleted' : ''}`}>{name}</span>
              <span className="change-dir">{dir}</span>
              <span className="change-stats">
                {f.added > 0 && <span className="add">+{f.added}</span>}
                {f.deleted > 0 && <span className="del">−{f.deleted}</span>}
              </span>
              {f.status !== 'D' && (
                <button
                  className="icon-btn change-open"
                  title="Open file"
                  onClick={(e) => {
                    e.stopPropagation()
                    openFile(f.abs)
                  }}
                >
                  <ExternalLink size={13} />
                </button>
              )}
              <span className={`change-badge git-${st}`}>{st}</span>
            </div>
          )
        })}
        <HistoryList />
      </div>
    </>
  )
}

/** The current branch; click to switch to another one (remote-only branches get a local copy). */
function BranchPicker({ root, branch }: { root: string; branch: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<GitBranchInfo[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    setQ('')
    setError('')
    setList(null)
    let live = true
    window.api.git
      .branches(root)
      .then((b) => live && setList(b))
      .catch((e) => live && setError(String(e)))
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      live = false
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open, root])

  const needle = q.trim().toLowerCase()
  const shown = (list ?? []).filter((b) => b.name.toLowerCase().includes(needle))
  const pick = async (b: GitBranchInfo): Promise<void> => {
    if (busy) return
    if (b.current) return setOpen(false)
    setBusy(b.name)
    setError('')
    try {
      await window.api.git.checkout(root, b.name, b.remote)
      setOpen(false)
      refreshGit()
    } catch (e) {
      // e.g. uncommitted changes that the other branch would overwrite: git's own words
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="branch-picker" ref={ref}>
      <button className={`changes-branch${open ? ' open' : ''}`} title="Switch branch" onClick={() => setOpen(!open)}>
        <GitBranch size={13} />
        <span className="branch-name">{branch}</span>
        <ChevronDown size={12} className="branch-caret" />
      </button>
      {open && (
        <div className="branch-menu" role="menu">
          <input
            className="branch-filter"
            autoFocus
            placeholder="Find a branch…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && shown[0] && void pick(shown[0])}
          />
          <div className="branch-list">
            {!list && !error && (
              <div className="branch-note">
                <Loader2 size={12} className="spin" /> Loading…
              </div>
            )}
            {list && !shown.length && <div className="branch-note">No branch matches.</div>}
            {shown.map((b) => (
              <button
                key={(b.remote ? 'r:' : 'l:') + b.name}
                role="menuitemradio"
                aria-checked={b.current}
                className={`branch-item${b.current ? ' on' : ''}`}
                disabled={!!busy}
                title={b.remote ? `Check out ${b.name} as a local branch` : `Switch to ${b.name}`}
                onClick={() => void pick(b)}
              >
                {busy === b.name ? <Loader2 size={13} className="spin" /> : <Check size={13} className="branch-check" />}
                <span className="branch-item-name">{b.name}</span>
                {b.remote && <span className="branch-hint">remote</span>}
              </button>
            ))}
          </div>
          {error && <div className="branch-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

/* ================================ History ================================ */

/** Commits on the current branch, newest first; click one to see the files it touched. */
function HistoryList(): React.JSX.Element | null {
  const gitRoot = useStore((s) => s.git.root)
  const branch = useStore((s) => s.git.branch)
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  // a commit / pull / checkout moves HEAD or a ref even when the working tree status stays the same
  const [refs, setRefs] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => setRefs((n) => n + 1), 300)
    }
    window.addEventListener('git-changed', onChange)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('git-changed', onChange)
    }
  }, [])

  // refetch when HEAD / a ref moves (new commits, checkout, pull…), not on every working-tree change
  useEffect(() => {
    if (!gitRoot) return
    let live = true
    window.api.git.log(gitRoot).then((c) => live && setCommits(c))
    return () => {
      live = false
    }
  }, [gitRoot, branch, refs])

  if (!gitRoot || !commits) return null
  return (
    <>
      <SectionHeader title={`History${commits.length ? ` · ${commits.length}` : ''}`} />
      {commits.length === 0 && <div className="history-empty">No commits yet.</div>}
      {commits.map((c) => (
        <CommitRow key={c.hash} commit={c} gitRoot={gitRoot} open={open === c.hash} toggle={() => setOpen((o) => (o === c.hash ? null : c.hash))} />
      ))}
    </>
  )
}

function CommitRow({ commit, gitRoot, open, toggle }: { commit: GitCommit; gitRoot: string; open: boolean; toggle: () => void }): React.JSX.Element {
  const [files, setFiles] = useState<GitCommitFile[] | null>(null)
  const activeTabId = useStore((s) => s.activeTabId)
  useEffect(() => {
    if (!open || files) return
    let live = true
    window.api.git.commitFiles(gitRoot, commit.hash).then((f) => live && setFiles(f))
    return () => {
      live = false
    }
  }, [open, files, gitRoot, commit.hash])

  return (
    <>
      <div
        className={`commit-row${open ? ' open' : ''}`}
        onClick={toggle}
        title={`${commit.subject}\n${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`}
      >
        <ChevronRight size={12} className={`chev${open ? ' open' : ''}`} />
        <GitCommitHorizontal size={13} className="commit-icon" />
        <div className="commit-text">
          <span className="commit-subject">{commit.subject}</span>
          <span className="commit-meta">
            <span className="commit-hash">{commit.short}</span> · {commit.author} · {shortAgo(commit.date)}
          </span>
        </div>
      </div>
      {open && !files && <div className="tree-loading" />}
      {open && files?.length === 0 && <div className="history-empty">No file changes.</div>}
      {open &&
        files?.map((f) => {
          const name = f.rel.split('/').pop()!
          const dir = f.rel.slice(0, -name.length - 1)
          const active = activeTabId === `c:${commit.hash}:${f.rel}`
          return (
            <div
              key={f.rel}
              className={`change-row commit-file${active ? ' active' : ''}`}
              onClick={() => openCommitDiff(gitRoot, commit, f.rel)}
              title={`${statusName[f.status]} — ${f.rel}`}
            >
              <FileIcon name={name} />
              <span className={`change-name${f.status === 'D' ? ' deleted' : ''}`}>{name}</span>
              <span className="change-dir">{dir}</span>
              <span className="change-stats">
                {f.added > 0 && <span className="add">+{f.added}</span>}
                {f.deleted > 0 && <span className="del">−{f.deleted}</span>}
              </span>
              <span className={`change-badge git-${f.status}`}>{f.status}</span>
            </div>
          )
        })}
    </>
  )
}
