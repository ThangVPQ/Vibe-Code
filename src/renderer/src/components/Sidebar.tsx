import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Collapse, SlidePill } from './motion'
import {
  ChevronRight,
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
  Search
} from 'lucide-react'
import { basename, useStore, type Chat } from '../store'
import { closeChat, loadSessions, openFolder, newChat, newChatIn, openCommitDiff, openDiff, openFile, openSession, refreshGit, renameChat, selectChat } from '../actions'
import { FileIcon, FolderIcon, StatusDot, statusLabel } from './icons'
import type { DirEntry, GitCommit, GitCommitFile, GitFile, ProjectGroup, SessionInfo } from '../../../shared/types'
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

  // Codex / Grok / Gemini… chats aren't in Claude's session store: list the open ones under their
  // project, adding the project when it has no Claude history yet.
  const slashKey = (p: string): string => normKey(p).replace(/\//g, '\\')
  const agentChats = chats.filter((c) => agentDef(c.agent).id !== 'claude')
  const allProjects: ProjectGroup[] = [...projects]
  for (const c of agentChats) {
    if (allProjects.some((g) => slashKey(g.key) === slashKey(c.cwd))) continue
    allProjects.unshift({ key: normKey(c.cwd), cwd: c.cwd, name: basename(c.cwd), updated: c.createdAt, sessions: [] })
  }
  const needle = q.trim().toLowerCase()
  const recent = useMemo(() => recentItems(projects, chats), [projects, chats])
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
            <div
              key={it.key}
              className={`sess-row${it.chat && it.chat.id === activeChatId ? ' active' : ''}`}
              onClick={() => (it.chat ? selectChat(it.chat.id) : it.session && void openSession(it.session))}
              title={`${it.title}
${it.project} · ${new Date(it.updated).toLocaleString()}`}
            >
              {it.chat ? <StatusDot status={it.chat.status} attention={it.chat.attention} /> : <span className="sess-bullet" />}
              <span className="sess-title">{it.title}</span>
              <span className="sess-time">{shortAgo(it.updated)}</span>
            </div>
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
            <div className={`proj-row${isRoot ? ' current' : ''}`} onClick={() => flip(setExpanded, g.key)} title={g.cwd}>
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
                title={`${c.title}\n${agentDef(c.agent).label} · ${c.cwd}`}
              >
                <StatusDot status={c.status} attention={c.attention} />
                <span className="sess-title">{c.title}</span>
                <span className="sess-time">{agentDef(c.agent).label}</span>
              </div>
            ))}
            {shown.map((s) => {
              const live = liveBySession.get(s.id)
              return (
                <div
                  key={s.id}
                  className={`sess-row${activeSession === s.id ? ' active' : ''}${s.cwdExists ? '' : ' gone'}`}
                  onClick={() => openSession(s)}
                  title={`${s.title}\n${s.cwd}\nUpdated ${new Date(s.updated).toLocaleString()}`}
                >
                  {live ? <StatusDot status={live.status} attention={live.attention} /> : <span className="sess-bullet" />}
                  <span className="sess-title">{s.title}</span>
                  <span className="sess-time">{shortAgo(s.updated)}</span>
                </div>
              )
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
  const files = useStore((s) => s.git.files)
  return useMemo(() => {
    const m = new Map<string, GitFile['status']>()
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
  }, [files])
}

export function ExplorerView(): React.JSX.Element | null {
  const root = useStore((s) => s.root)
  const [collapseKey, setCollapseKey] = useState(0)
  const deco = useGitDecorations()
  if (!root) return null
  return <ExplorerTree root={root} collapseKey={collapseKey} setCollapseKey={setCollapseKey} deco={deco} />
}

interface CtxTarget {
  x: number
  y: number
  path: string
  isDir: boolean
}
type OpenCtx = (e: React.MouseEvent, path: string, isDir: boolean) => void

function ExplorerTree(props: { root: string; collapseKey: number; setCollapseKey: (f: (k: number) => number) => void; deco: Map<string, string> }): React.JSX.Element {
  const { root, collapseKey, setCollapseKey, deco } = props
  const [ctx, setCtx] = useState<CtxTarget | null>(null)
  const openCtx: OpenCtx = (e, path, isDir) => {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, path, isDir })
  }
  return (
    <>
      <SectionHeader title="Explorer">
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
      <div className="scroll tree" key={collapseKey}>
        <DirChildren dir={root} depth={0} deco={deco} openCtx={openCtx} />
      </div>
      {ctx && <ExplorerMenu target={ctx} root={root} onClose={() => setCtx(null)} />}
    </>
  )
}

/** Right-click menu on a file or folder in the explorer. */
function ExplorerMenu({ target, root, onClose }: { target: CtxTarget; root: string; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<React.CSSProperties>({ left: target.x, top: target.y, visibility: 'hidden' })

  // keep the menu on screen — measured before paint so it never jumps
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({
      left: Math.max(4, Math.min(target.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(target.y, window.innerHeight - r.height - 4))
    })
  }, [target])

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    document.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  const rel = target.path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || '.'
  const run = (f: () => unknown) => (): void => {
    onClose()
    void f()
  }
  const items: [React.JSX.Element, string, () => void][] = [
    target.isDir
      ? [<FolderOpen size={14} key="o" />, 'Open folder in File Explorer', run(() => window.api.fs.openPath(target.path))]
      : [<FolderOpen size={14} key="o" />, 'Reveal in File Explorer', run(() => window.api.fs.reveal(target.path))],
    [<Copy size={14} key="p" />, 'Copy path', run(() => navigator.clipboard.writeText(target.path))],
    [<Copy size={14} key="r" />, 'Copy relative path', run(() => navigator.clipboard.writeText(rel))]
  ]
  if (target.isDir && target.path !== root)
    items.splice(1, 0, [<FolderOpen size={14} key="s" />, 'Reveal in parent folder', run(() => window.api.fs.reveal(target.path))])

  // portal to <body>: inside the sidebar a transformed/blurred ancestor breaks position:fixed
  return createPortal(
    <div ref={ref} className="menu ctx-menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map(([icon, label, act]) => (
        <button key={label} className="menu-item" onClick={act}>
          {icon}
          <span className="menu-item-main">{label}</span>
        </button>
      ))}
    </div>,
    document.body
  )
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

function TreeNode({ item, depth, deco, openCtx }: { item: DirEntry; depth: number; deco: Map<string, string>; openCtx: OpenCtx }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const activeTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const isActive = activeTab?.kind === 'file' && activeTab.path.toLowerCase() === item.path.toLowerCase()
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
}

/* ================================ Changes ================================ */

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
        <div className="changes-branch">
          <GitBranch size={13} /> {git.branch}
        </div>
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
            <div key={f.rel} className={`change-row${active ? ' active' : ''}`} onClick={() => openDiff(f.abs, f.rel)} title={`${statusName[f.status]} — ${f.rel}`}>
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

/* ================================ History ================================ */

/** Commits on the current branch, newest first; click one to see the files it touched. */
function HistoryList(): React.JSX.Element | null {
  const git = useStore((s) => s.git)
  const gitRoot = git.root
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  // a commit / pull / checkout moves HEAD or a ref even when the working tree status stays the same
  const [refs, setRefs] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = (e: Event): void => {
      if (!(e as CustomEvent<string[]>).detail.some((p) => /[\\/]\.git[\\/](HEAD|refs|packed-refs)/.test(p))) return
      clearTimeout(timer)
      timer = setTimeout(() => setRefs((n) => n + 1), 300)
    }
    window.addEventListener('fs-changed', onChange)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('fs-changed', onChange)
    }
  }, [])

  // refetch whenever git state refreshes (new commits, checkout, pull…)
  useEffect(() => {
    if (!gitRoot) return
    let live = true
    window.api.git.log(gitRoot).then((c) => live && setCommits(c))
    return () => {
      live = false
    }
  }, [gitRoot, git, refs])

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
