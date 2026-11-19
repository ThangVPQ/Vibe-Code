import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Code2, Columns2, Database, FileDiff, FileText, Rows2, X, Command, GitCompare, Globe, MessageCircle, MessageSquarePlus, Plus, Search } from 'lucide-react'
import { fileUri, useStore, type EditorTab } from '../store'
import { HOME_URL, browserKey, closeBrowserTab, closeTab, newBrowserTab, openBrowser, openFile, selectBrowserTab } from '../actions'
import { BrowserTab } from './Browser'
import { SlidePill } from './motion'
import { ChangesView, ExplorerView } from './Sidebar'
import { FileIcon, Logo } from './icons'
import { EditorFontButton } from './EditorFont'
import { RecentChats } from './Chrome'
// heavy parts load on first use: Monaco (~4 MB) only when a file or diff opens
const FileEditor = lazy(() => import('./MonacoViews').then((m) => ({ default: m.FileEditor })))
const DiffView = lazy(() => import('./MonacoViews').then((m) => ({ default: m.DiffView })))
const DatabasePane = lazy(() => import('./Database').then((m) => ({ default: m.DatabasePane })))
const ZaloPane = lazy(() => import('./Zalo').then((m) => ({ default: m.ZaloPane })))
import type { ZaloTasksState } from '../../../shared/types'
import { revealIn } from '../scroll'

/** Middle area: two fixed tabs — Source code (files, diffs) and Web (built-in browser). */
export function EditorArea(): React.JSX.Element {
  const view = useStore((s) => s.centerView)
  const fileCount = useStore((s) => s.tabs.length)
  const key = useStore((s) => browserKey(s.activeChatId))
  const browsers = useStore((s) => s.browsers)
  // the Database tab mounts on first visit, then stays (keeps its SQL, results and open tree)
  const [dbSeen, setDbSeen] = useState(view === 'db')
  const [zaloSeen, setZaloSeen] = useState(view === 'zalo')
  useEffect(() => {
    if (view === 'db') setDbSeen(true)
    if (view === 'zalo') setZaloSeen(true)
  }, [view])
  const zaloBadge = useZaloBadge(view === 'zalo')
  // switching chats while on Web: give that chat its own browser (before paint: no empty frame)
  useLayoutEffect(() => {
    if (view === 'web' && !browsers[key]) openBrowser()
  }, [view, key, browsers])
  return (
    <div className="center-area">
      <RecentChats />
      <div className="center-switch" role="tablist">
        <SlidePill />
        <button role="tab" aria-selected={view === 'code'} className={view === 'code' ? 'on' : ''} onClick={() => useStore.setState({ centerView: 'code' })}>
          <Code2 size={14} /> Source code
          {fileCount > 0 && <span className="center-count">{fileCount}</span>}
        </button>
        <button role="tab" aria-selected={view === 'web'} className={view === 'web' ? 'on' : ''} onClick={() => openBrowser()}>
          <Globe size={14} /> Web
        </button>
        <button role="tab" aria-selected={view === 'db'} className={view === 'db' ? 'on' : ''} onClick={() => useStore.setState({ centerView: 'db' })}>
          <Database size={14} /> Database
        </button>
        <button role="tab" aria-selected={view === 'zalo'} className={view === 'zalo' ? 'on' : ''} onClick={() => useStore.setState({ centerView: 'zalo' })}>
          <MessageCircle size={14} /> Zalo
          {zaloBadge > 0 && (
            <span key={zaloBadge} className="center-count alert" title={`${zaloBadge} việc mới / vừa cập nhật`}>
              {zaloBadge > 99 ? '99+' : zaloBadge}
            </span>
          )}
        </button>
      </div>
      {/* Source code: the whole project of the open chat — file tree on the left, files on the right */}
      <div className="center-pane code-pane" style={{ display: view === 'code' ? 'flex' : 'none' }}>
        <CodeSide />
        <CodeArea />
      </div>
      {dbSeen && (
        <div className="center-pane db-host" style={{ display: view === 'db' ? 'flex' : 'none' }}>
          <Suspense fallback={null}>
            <DatabasePane />
          </Suspense>
        </div>
      )}
      {zaloSeen && (
        <div className="center-pane zalo-host" style={{ display: view === 'zalo' ? 'flex' : 'none' }}>
          <Suspense fallback={null}>
            <ZaloPane />
          </Suspense>
        </div>
      )}
      {/* one browser per chat, every tab kept alive so pages survive switching */}
      {Object.keys(browsers).map((k) => (
        <div key={k} className="center-pane browser-host" style={{ display: view === 'web' && k === key ? 'flex' : 'none' }}>
          <WebTabs chatKey={k} />
        </div>
      ))}
    </div>
  )
}

/**
 * Zalo tab badge: tasks Claude created or changed that I haven't looked at.
 * Also tells main when the tab is on screen in a focused window (that clears the badge, and skips pop-ups).
 */
function useZaloBadge(onTab: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const count = (s: ZaloTasksState): void => {
      setN(Object.keys(s.unseen ?? {}).length)
      taskbarBadge(s.tasks.filter((t) => t.status !== 'done').length)
    }
    void window.api.zalo.tasks().then(count)
    return window.api.zalo.onTasks(count)
  }, [])
  useEffect(() => {
    const send = (): void => window.api.zalo.tasksViewing(onTab && document.hasFocus() && !document.hidden)
    send()
    window.addEventListener('focus', send)
    window.addEventListener('blur', send)
    document.addEventListener('visibilitychange', send)
    return () => {
      window.removeEventListener('focus', send)
      window.removeEventListener('blur', send)
      document.removeEventListener('visibilitychange', send)
    }
  }, [onTab])
  return n
}

/** Red number over the app's taskbar icon: my unfinished Zalo tasks. */
let lastBadge = -1
function taskbarBadge(n: number): void {
  if (n === lastBadge) return
  lastBadge = n
  if (n <= 0) return window.api.win.badge(null, '')
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')
  if (!g) return
  g.fillStyle = '#e5484d'
  g.beginPath()
  g.arc(16, 16, 16, 0, Math.PI * 2)
  g.fill()
  const text = n > 99 ? '99+' : String(n)
  g.fillStyle = '#fff'
  g.font = `bold ${text.length > 2 ? 13 : text.length > 1 ? 18 : 22}px "Segoe UI", sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 16, 17)
  window.api.win.badge(c.toDataURL('image/png'), `${n} việc chưa xong`)
}

/** A chat's browser: its tab strip and one page per tab. */
function WebTabs({ chatKey }: { chatKey: string }): React.JSX.Element | null {
  const b = useStore((s) => s.browsers[chatKey])
  const shown = useStore((s) => s.centerView === 'web' && browserKey(s.activeChatId) === chatKey)
  const stripRef = useRef<HTMLDivElement>(null)
  // tabs on their way out: they shrink away first, then really close
  const [closing, setClosing] = useState<Set<string>>(new Set())
  const close = (id: string): void => {
    if (closing.has(id)) return
    setClosing((c) => new Set(c).add(id))
    setTimeout(() => {
      closeBrowserTab(chatKey, id)
      setClosing((c) => {
        const n = new Set(c)
        n.delete(id)
        return n
      })
    }, 200)
  }

  useEffect(() => {
    revealIn(stripRef.current, stripRef.current?.querySelector('.tab.active'), { inline: 'nearest', smooth: true })
  }, [b?.active, b?.tabs.length])

  if (!b) return null
  const activeIdx = b.tabs.findIndex((t) => t.id === b.active)
  return (
    <>
      <div className="tab-strip web-tab-strip" ref={stripRef} onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
        <SlidePill className="tab-pill" />
        {b.tabs.map((t) => (
          <div
            key={t.id}
            className={`tab${t.id === b.active ? ' active' : ''}${closing.has(t.id) ? ' closing' : ''}`}
            onClick={() => selectBrowserTab(chatKey, t.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                close(t.id)
              }
            }}
            title={t.url === HOME_URL ? 'New tab' : t.url}
          >
            <Globe size={13} />
            <span className="tab-title">{t.title || (t.url === HOME_URL ? 'New tab' : t.url.replace(/^https?:\/\//, ''))}</span>
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                close(t.id)
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="icon-btn tab-strip-btn" title="New tab" onClick={() => newBrowserTab(chatKey)}>
          <Plus size={15} />
        </button>
        <div className="tab-strip-fill" />
      </div>
      {/* every page stays laid out (no display:none → no re-layout flash); the open one slides in */}
      <div className="browser-deck">
        {b.tabs.map((t, i) => (
          <div key={t.id} className={`browser-tab-pane ${i === activeIdx ? 'on' : i < activeIdx ? 'left' : 'right'}`}>
            <BrowserTab chatKey={chatKey} tabId={t.id} active={t.id === b.active} onScreen={shown} />
          </div>
        ))}
      </div>
    </>
  )
}

/** Left column of Source code: the project's files, or its Git changes (click one for the diff). */
function CodeSide(): React.JSX.Element {
  // in the store: Ctrl+Shift+E / Ctrl+Shift+G switch it
  const side = useStore((s) => s.codeSide)
  const setSide = (codeSide: 'files' | 'changes'): void => useStore.setState({ codeSide })
  const changed = useStore((s) => s.git.files.length)
  const hasRoot = useStore((s) => !!s.root)
  return (
    <div className="sidebar code-tree">
      <div className="code-side-switch">
        <SlidePill />
        <button className={side === 'files' ? 'on' : ''} onClick={() => setSide('files')}>
          <FileText size={13} /> Files
        </button>
        <button className={side === 'changes' ? 'on' : ''} onClick={() => setSide('changes')}>
          <GitCompare size={13} /> Changes
          {changed > 0 && <span className="center-count">{changed}</span>}
        </button>
      </div>
      {hasRoot && (side === 'files' ? <ExplorerView /> : <ChangesView />)}
    </div>
  )
}

function CodeArea(): React.JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeId) ?? null
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    revealIn(stripRef.current, stripRef.current?.querySelector('.tab.active'), { inline: 'nearest', smooth: true })
  }, [activeId])

  return (
    <div className="editor-area">
      {tabs.length > 0 && (
        <div className="tab-row">
        <div className="tab-strip" ref={stripRef} onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}>
          <SlidePill className="tab-pill" />
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab${t.id === activeId ? ' active' : ''}${t.kind === 'diff' ? ' diff' : ''}`}
              onClick={() => useStore.setState({ activeTabId: t.id })}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(t.id)
                }
              }}
              title={t.path}
            >
              {t.kind === 'diff' ? <FileDiff size={14} color="#8aa5ee" /> : <FileIcon name={t.title} size={14} />}
              <span className="tab-title">{t.title}</span>
              {t.kind === 'diff' && <span className="tab-tag">diff</span>}
              <button
                className={`tab-close${t.kind === 'file' && t.dirty ? ' dirty' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <div className="tab-strip-fill" />
        </div>
        <EditorFontButton />
        </div>
      )}
      <div className="editor-body">
        {!active && <EmptyEditor />}
        <Suspense fallback={null}>
          {active?.kind === 'file' && <FileEditor key={active.id} tab={active} />}
          {active?.kind === 'diff' && <DiffView key={active.id} tab={active} />}
        </Suspense>
      </div>
    </div>
  )
}

/* ================================ Empty state ================================ */

function EmptyEditor(): React.JSX.Element {
  const rows: [React.ReactNode, string, string][] = [
    [<Search size={14} key="s" />, 'Go to file', 'Ctrl+P'],
    [<MessageSquarePlus size={14} key="n" />, 'New chat', 'Ctrl+Shift+N'],
    [<GitCompare size={14} key="g" />, 'Show changes', 'Ctrl+Shift+G'],
    [<Command size={14} key="t" />, 'Toggle terminal', 'Ctrl+`'],
    [<Command size={14} key="b" />, 'Toggle sidebar', 'Ctrl+B']
  ]
  return (
    <div className="empty-editor">
      <div className="empty-logo">
        <Logo size={64} />
      </div>
      <button className="btn btn-primary btn-lg" onClick={() => openBrowser()}>
        <Globe size={16} /> Open browser
      </button>
      <div className="shortcut-list">
        {rows.map(([icon, label, key]) => (
          <div key={label} className="shortcut-row">
            <span className="shortcut-label">
              {icon} {label}
            </span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
    </div>
  )
}
