import { useEffect, useRef, useState } from 'react'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import { Braces, Columns2, FileText, GitCompare, Rows2 } from 'lucide-react'
import { openFile } from '../actions'
import { SlidePill } from './motion'
import { fileUri, useStore, type EditorTab } from '../store'
import { editorOptions, languageFor, monaco } from '../monaco'
import { ensureModel, isDirty, markTab, saveModel } from '../fileModels'
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

  // Ctrl+Shift+O, "@" in Ctrl+P or the breadcrumb button → "Go to Symbol" in the open file
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
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

