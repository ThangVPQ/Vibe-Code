import { useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import { Braces, Columns2, FileText, GitCompare, Rows2 } from 'lucide-react'
import { openFile } from '../actions'
import { SlidePill } from './motion'
import { fileUri, useStore, type EditorTab } from '../store'
import { editorOptions, languageFor, monaco } from '../monaco'
import { ensureModel, getModel, isDirty, markTab, saveModel } from '../fileModels'
import { FileIcon } from './icons'
import { useEditorFont } from './EditorFont'

/* Everything that needs Monaco: loaded the first time a file or diff tab opens. */

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
      <button className="crumb-symbols" title="Go to function / symbol (Ctrl+Shift+O)" onClick={() => window.dispatchEvent(new Event('go-to-symbol'))}>
        <Braces size={13} /> Symbols
      </button>
    </div>
  )
}

/* ================================ File editor ================================ */

const useMonacoTheme = (): string => useStore((s) => (s.themeResolved === 'light' ? 'studio-light' : 'studio-dark'))

export function FileEditor({ tab }: { tab: Extract<EditorTab, { kind: 'file' }> }): React.JSX.Element {
  const theme = useMonacoTheme()
  const font = useEditorFont()
  // One editor for every file tab: switching tabs swaps its model (Monaco keeps each file's scroll
  // and cursor) instead of tearing the whole editor down and building a new one.
  const [loaded, setLoaded] = useState<{ path: string; error?: string } | null>(null)

  useEffect(() => {
    let live = true
    ensureModel(tab.path).then((r) => live && setLoaded({ path: tab.path, error: r.error }))
    return () => {
      live = false
    }
  }, [tab.path])

  const mine = loaded?.path === tab.path ? loaded : null
  // The file on screen: this tab's as soon as its model exists (an already-open file switches in
  // the same frame); while a new file is still being read, the previous one stays up.
  const path = mine ? (mine.error ? null : tab.path) : getModel(tab.path) ? tab.path : loaded && !loaded.error ? loaded.path : null

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // what the editor's commands act on (they are registered once, the file changes)
  const pathRef = useRef(path)
  useEffect(() => {
    pathRef.current = path
    editorRef.current?.focus()
  }, [path])

  // Ctrl+Shift+O, "@" in Ctrl+P or the breadcrumb button → "Go to Symbol" in the open file
  useEffect(() => {
    const go = (): void => {
      const ed = editorRef.current
      if (!ed || useStore.getState().activeTabId !== tab.id) return
      ed.focus()
      ed.trigger('vibe', 'editor.action.quickOutline', null)
    }
    // Ctrl+G from outside the editor, or ":" in Ctrl+P
    const line = (): void => {
      const ed = editorRef.current
      if (!ed || useStore.getState().activeTabId !== tab.id) return
      ed.focus()
      ed.trigger('vibe', 'editor.action.gotoLine', null)
    }
    window.addEventListener('go-to-symbol', go)
    window.addEventListener('go-to-line', line)
    return () => {
      window.removeEventListener('go-to-symbol', go)
      window.removeEventListener('go-to-line', line)
    }
  }, [tab.id])

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.onDidDispose(() => editorRef.current === editor && (editorRef.current = null))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (pathRef.current) void saveModel(pathRef.current)
    })
    editor.onDidChangeModelContent(() => {
      // Once the edit has settled: during an undo, or a reload from disk, this event fires before
      // the model is back at its saved version — reading it right away left a false "unsaved" dot.
      queueMicrotask(() => {
        const m = editor.getModel()
        if (m && pathRef.current) markTab(pathRef.current, isDirty(m))
      })
    })
    editor.focus()
  }

  if (mine?.error) return <div className="editor-message">{mine.error}</div>
  if (!path) return <div className="editor-message" />
  return (
    <>
      <Breadcrumbs path={path} />
      <div className="monaco-wrap">
        <Editor
          path={fileUri(path)}
          language={languageFor(path)}
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

export function DiffView({ tab }: { tab: Extract<EditorTab, { kind: 'diff' }> }): React.JSX.Element {
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
          <GitCompare size={14} color="#5aa9ff" />
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

