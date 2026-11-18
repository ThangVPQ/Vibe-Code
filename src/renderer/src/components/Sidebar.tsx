import { useEffect, useMemo, useRef, useState } from 'react'
import { Collapse, SlidePill } from './motion'
import {
  ChevronRight,
  FolderGit2,
  FolderPlus,
  History,
  Plus,
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
import { basename, useStore } from '../store'
import { closeChat, loadSessions, openFolder, newChat, newChatIn, openCommitDiff, openDiff, openFile, openSession, refreshGit, renameChat, selectChat } from '../actions'
import { FileIcon, FolderIcon, StatusDot, statusLabel } from './icons'
import type { DirEntry, GitCommit, GitCommitFile, GitFile } from '../../../shared/types'

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
  const disabled = !useStore((s) => s.claude?.found)
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

/** Every project + conversation from Claude Code's store — the same list the Claude app shows. */
function ProjectsTree(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const root = useStore((s) => s.root)
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const claudeFound = useStore((s) => !!s.claude?.found)
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

  const needle = q.trim().toLowerCase()
  const visible = needle
    ? projects
        .map((g) => ({
          ...g,
          sessions: g.name.toLowerCase().includes(needle) ? g.sessions : g.sessions.filter((s) => s.title.toLowerCase().includes(needle))
        }))
        .filter((g) => g.sessions.length > 0)
    : projects

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

      {visible.length === 0 && <div className="tree-empty">{projects.length ? 'No matching chats' : 'No Claude Code history found yet.'}</div>}

      {visible.map((g) => {
        const open = needle ? true : expanded.has(g.key)
        const isRoot = !!root && normKey(root) === g.key
        const liveCount = g.sessions.filter((s) => liveBySession.has(s.id)).length
        const shown = needle || more.has(g.key) ? g.sessions : g.sessions.slice(0, PAGE)
        return (
          <div key={g.key} className="proj">
            <div className={`proj-row${isRoot ? ' current' : ''}`} onClick={() => flip(setExpanded, g.key)} title={g.cwd}>
              <span className="proj-name">{g.name}</span>
              <ChevronRight size={13} className={`proj-chev${open ? ' open' : ''}`} />
              {liveCount > 0 && <span className="proj-live" title={`${liveCount} open`} />}
              <span className="proj-spacer" />
              <button
                className="icon-btn tiny proj-add"
                title={`New chat in ${g.name}`}
                disabled={!claudeFound}
                onClick={(e) => {
                  e.stopPropagation()
                  newChatIn(g.cwd)
                }}
              >
                <Plus size={14} />
              </button>
            </div>
            <Collapse open={open}>
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

function shortAgo(t: number): string {
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
      const abs = f.abs.replace(/\//g, '\\').toLowerCase()
      m.set(abs, f.status)
      // bubble up to parent folders
      let p = abs
      while (p.includes('\\')) {
        p = p.slice(0, p.lastIndexOf('\\'))
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
  const [pos, setPos] = useState({ left: target.x, top: target.y })

  // keep the menu on screen
  useEffect(() => {
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

  return (
    <div ref={ref} className="menu ctx-menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map(([icon, label, act]) => (
        <button key={label} className="menu-item" onClick={act}>
          {icon}
          <span className="menu-item-main">{label}</span>
        </button>
      ))}
    </div>
  )
}

function DirChildren({ dir, depth, deco, openCtx }: { dir: string; depth: number; deco: Map<string, string>; openCtx: OpenCtx }): React.JSX.Element {
  const [items, setItems] = useState<DirEntry[] | null>(null)
  const tick = useStore((s) => s.fsTick)
  useEffect(() => {
    let live = true
    window.api.fs
      .readDir(dir)
      .then((r) => live && setItems(r))
      .catch(() => live && setItems([]))
    return () => {
      live = false
    }
  }, [dir, tick])
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
  const status = deco.get(item.path.toLowerCase())
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

  // refetch whenever git state refreshes (new commits, checkout, pull…)
  useEffect(() => {
    if (!gitRoot) return
    let live = true
    window.api.git.log(gitRoot).then((c) => live && setCommits(c))
    return () => {
      live = false
    }
  }, [gitRoot, git])

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
