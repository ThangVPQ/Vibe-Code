import { useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import { Code2, Columns2, Database, FileDiff, FileText, Rows2, X, Command, GitCompare, Globe, MessageCircle, MessageSquarePlus, Plus, Search } from 'lucide-react'
import { fileUri, useStore, type EditorTab } from '../store'
import { HOME_URL, browserKey, closeBrowserTab, closeTab, newBrowserTab, openBrowser, openFile, selectBrowserTab } from '../actions'
import { BrowserTab } from './Browser'
import { SlidePill } from './motion'
import { ChangesView, ExplorerView } from './Sidebar'
import { editorOptions, languageFor, monaco } from '../monaco'
import { ensureModel, isDirty, markTab, saveModel } from '../fileModels'
import { FileIcon, Logo } from './icons'
import { EditorFontButton, useEditorFont } from './EditorFont'
import { DatabasePane } from './Database'
import { ZaloPane, useZaloUnread } from './Zalo'

/** Middle area: two fixed tabs — Source code (files, diffs) and Web (built-in browser). */
export function EditorArea(): React.JSX.Element {
  const view = useStore((s) => s.centerView)
  const fileCount = useStore((s) => s.tabs.length)
  const key = useStore((s) => browserKey(s.activeChatId))
  const browsers = useStore((s) => s.browsers)
  const zaloUnread = useZaloUnread()
  // the Database tab mounts on first visit, then stays (keeps its SQL, results and open tree)
  const [dbSeen, setDbSeen] = useState(view === 'db')
  const [zaloSeen, setZaloSeen] = useState(view === 'zalo')
  useEffect(() => {
    if (view === 'db') setDbSeen(true)
    if (view === 'zalo') setZaloSeen(true)
  }, [view])
  // switching chats while on Web: give that chat its own browser
  useEffect(() => {
    if (view === 'web' && !browsers[key]) openBrowser()
  }, [view, key, browsers])
  return (
    <div className="center-area">
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
          {zaloUnread > 0 && <span className="center-count zl-tab-count">{zaloUnread > 99 ? '99+' : zaloUnread}</span>}
        </button>
      </div>
      {/* Source code: the whole project of the open chat — file tree on the left, files on the right */}
      <div className="center-pane code-pane" style={{ display: view === 'code' ? 'flex' : 'none' }}>
        <CodeSide />
        <CodeArea />
      </div>
      {dbSeen && (
        <div className="center-pane db-host" style={{ display: view === 'db' ? 'flex' : 'none' }}>
          <DatabasePane />
        </div>
      )}
      {zaloSeen && (
        <div className="center-pane zalo-host" style={{ display: view === 'zalo' ? 'flex' : 'none' }}>
          <ZaloPane />
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

/** A chat's browser: its tab strip and one page per tab. */
function WebTabs({ chatKey }: { chatKey: string }): React.JSX.Element | null {
  const b = useStore((s) => s.browsers[chatKey])
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
    stripRef.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
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
            <BrowserTab chatKey={chatKey} tabId={t.id} active={t.id === b.active} />
          </div>
        ))}
      </div>
    </>
  )
}

/** Left column of Source code: the project's files, or its Git changes (click one for the diff). */
function CodeSide(): React.JSX.Element {
  const [side, setSide] = useState<'files' | 'changes'>('files')
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
    stripRef.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
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
        {active?.kind === 'file' && <FileEditor key={active.id} tab={active} />}
        {active?.kind === 'diff' && <DiffView key={active.id} tab={active} />}
      </div>
    </div>
  )
}

function Breadcrumbs({ path }: { path: string }): React.JSX.Element {
  const root = useStore((s) => s.root) ?? ''
  const rel = path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length).replace(/^[\\/]/, '') : path
  const parts = rel.split(/[\\/]/)
  return (
    <div className="breadcrumbs">
      {parts.map((p, i) => (
        <span key={i} className={i === parts.length - 1 ? 'crumb last' : 'crumb'}>
          {i === parts.length - 1 && <FileIcon name={p} size={13} />}
          {p}
          {i < parts.length - 1 && <span className="crumb-sep">›</span>}
        </span>
      ))}
    </div>
  )
}

/* ================================ File editor ================================ */

const useMonacoTheme = (): string => useStore((s) => (s.themeResolved === 'light' ? 'studio-light' : 'studio-dark'))

function FileEditor({ tab }: { tab: Extract<EditorTab, { kind: 'file' }> }): React.JSX.Element {
  const theme = useMonacoTheme()
  const font = useEditorFont()
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    ensureModel(tab.path).then((r) => {
      if (!live) return
      if (r.error) setError(r.error)
      else setReady(true)
    })
    return () => {
      live = false
    }
  }, [tab.path])

  const onMount: OnMount = (editor) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveModel(tab.path))
    editor.onDidChangeModelContent(() => {
      const m = editor.getModel()
      if (m) markTab(tab.path, isDirty(m))
    })
    editor.focus()
  }

  if (error) return <div className="editor-message">{error}</div>
  if (!ready) return <div className="editor-message" />
  return (
    <>
      <Breadcrumbs path={tab.path} />
      <div className="monaco-wrap">
        <Editor
          path={fileUri(tab.path)}
          language={languageFor(tab.path)}
          theme={theme}
          options={{ ...editorOptions, ...font }}
          keepCurrentModel
          onMount={onMount}
        />
      </div>
    </>
  )
}

/* ================================ Diff view ================================ */

function DiffView({ tab }: { tab: Extract<EditorTab, { kind: 'diff' }> }): React.JSX.Element {
  const theme = useMonacoTheme()
  const font = useEditorFont()
  const gitRoot = useStore((s) => s.git.root)
  const file = useStore((s) => s.git.files.find((f) => f.abs.toLowerCase() === tab.path.toLowerCase()))
  const sideBySide = useStore((s) => s.diffSideBySide)
  const [texts, setTexts] = useState<{ original: string; modified: string } | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const onChange = (e: Event): void => {
      const paths = (e as CustomEvent<string[]>).detail
      if (paths.some((p) => p.toLowerCase() === tab.path.toLowerCase())) setVersion((v) => v + 1)
    }
    window.addEventListener('fs-changed', onChange)
    return () => window.removeEventListener('fs-changed', onChange)
  }, [tab.path])

  const commit = tab.commit
  useEffect(() => {
    if (!gitRoot) return
    let live = true
    Promise.all(
      commit
        ? [window.api.git.show(gitRoot, commit.hash + '^', tab.rel), window.api.git.show(gitRoot, commit.hash, tab.rel)]
        : [
            window.api.git.original(gitRoot, tab.rel),
            window.api.fs
              .readFile(tab.path)
              .then((r) => (r.binary ? '[binary file]' : r.content))
              .catch(() => '')
          ]
    ).then(([original, modified]) => live && setTexts({ original, modified }))
    return () => {
      live = false
    }
  }, [gitRoot, tab.rel, tab.path, commit, version])

  const lang = languageFor(tab.path)
  const label = commit
    ? `${commit.short} · ${commit.subject}`
    : file?.status === '?' || file?.status === 'A'
      ? 'New file'
      : file?.status === 'D'
        ? 'Deleted'
        : 'Working tree ↔ HEAD'

  return (
    <>
      <div className="diff-header">
        <div className="diff-title">
          <GitCompare size={14} color="#8aa5ee" />
          <span className="diff-path">{tab.rel}</span>
          <span className="diff-label">{label}</span>
          {file && !commit && (
            <span className="diff-stats">
              <span className="add">+{file.added}</span>
              <span className="del">−{file.deleted}</span>
            </span>
          )}
        </div>
        <div className="diff-actions">
          <div className="seg">
            <SlidePill />
            <button className={sideBySide ? 'on' : ''} onClick={() => useStore.setState({ diffSideBySide: true })} title="Side by side">
              <Columns2 size={14} />
            </button>
            <button className={!sideBySide ? 'on' : ''} onClick={() => useStore.setState({ diffSideBySide: false })} title="Inline">
              <Rows2 size={14} />
            </button>
          </div>
          {(commit || file?.status !== 'D') && (
            <button className="btn btn-ghost btn-sm" onClick={() => openFile(tab.path)}>
              <FileText size={13} /> Open file
            </button>
          )}
        </div>
      </div>
      <div className="monaco-wrap">
        {texts && (
          <DiffEditor
            original={texts.original}
            modified={texts.modified}
            language={lang}
            originalModelPath={(commit ? `git-${commit.short}-parent:///` : 'git-head:///') + tab.rel}
            modifiedModelPath={(commit ? `git-${commit.short}:///` : 'working:///') + tab.rel}
            theme={theme}
            options={{
              ...editorOptions,
              ...font,
              readOnly: true,
              originalEditable: false,
              renderSideBySide: sideBySide,
              useInlineViewWhenSpaceIsLimited: true,
              ignoreTrimWhitespace: false,
              renderOverviewRuler: true,
              hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6, revealLineCount: 20 },
              diffWordWrap: 'off',
              minimap: { enabled: false },
              stickyScroll: { enabled: false }
            }}
          />
        )}
      </div>
    </>
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
