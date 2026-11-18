import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// We only want to *view and edit* files, not type-check a whole project we can't see.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
monaco.typescript.typescriptDefaults.setCompilerOptions({
  jsx: monaco.typescript.JsxEmit.Preserve,
  target: monaco.typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true
})

monaco.editor.defineTheme('studio-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b6b85', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c49bff' },
    { token: 'string', foreground: '9fe0a8' },
    { token: 'number', foreground: 'f5b46b' },
    { token: 'type', foreground: '6fd6e8' },
    { token: 'type.identifier', foreground: '6fd6e8' },
    { token: 'function', foreground: '7fb2ff' },
    { token: 'variable', foreground: 'e4e4ee' },
    { token: 'tag', foreground: 'ff8f7a' },
    { token: 'attribute.name', foreground: 'f5c76b' },
    { token: 'delimiter', foreground: '9a9ab0' }
  ],
  colors: {
    'editor.background': '#252e49',
    'editor.foreground': '#e4e4ee',
    'editorLineNumber.foreground': '#56628a',
    'editorLineNumber.activeForeground': '#b9b9cc',
    'editor.lineHighlightBackground': '#2b3554',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#6f8fe63d',
    'editor.inactiveSelectionBackground': '#6f8fe622',
    'editorCursor.foreground': '#8aa5ee',
    'editorIndentGuide.background1': '#22222e',
    'editorIndentGuide.activeBackground1': '#3a3a4c',
    'editorWhitespace.foreground': '#2a2a38',
    'editorGutter.background': '#252e49',
    'editorWidget.background': '#17171f',
    'editorWidget.border': '#2a2a38',
    'editorSuggestWidget.background': '#17171f',
    'editorSuggestWidget.selectedBackground': '#262634',
    'editorHoverWidget.background': '#17171f',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff24',
    'scrollbarSlider.activeBackground': '#ffffff30',
    'minimap.background': '#252e49',
    'diffEditor.insertedTextBackground': '#2ea04333',
    'diffEditor.removedTextBackground': '#f8514933',
    'diffEditor.insertedLineBackground': '#2ea0431a',
    'diffEditor.removedLineBackground': '#f851491a',
    'diffEditor.diagonalFill': '#ffffff08',
    'editorOverviewRuler.border': '#00000000'
  }
})

monaco.editor.defineTheme('studio-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8a877d', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7a3fb8' },
    { token: 'string', foreground: '2f7a3e' },
    { token: 'number', foreground: 'b5552f' },
    { token: 'type', foreground: '1d6f86' },
    { token: 'type.identifier', foreground: '1d6f86' },
    { token: 'function', foreground: '2f5fb8' },
    { token: 'variable', foreground: '1f1e1d' },
    { token: 'tag', foreground: 'b5452f' },
    { token: 'attribute.name', foreground: '946210' },
    { token: 'delimiter', foreground: '6f6d66' }
  ],
  colors: {
    'editor.background': '#faf9f5',
    'editor.foreground': '#1f1e1d',
    'editorLineNumber.foreground': '#c4c0b3',
    'editorLineNumber.activeForeground': '#6f6d66',
    'editor.lineHighlightBackground': '#f2f0e8',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#6f8fe63a',
    'editor.inactiveSelectionBackground': '#6f8fe622',
    'editorCursor.foreground': '#c96442',
    'editorIndentGuide.background1': '#ebe8de',
    'editorIndentGuide.activeBackground1': '#d6d2c4',
    'editorGutter.background': '#faf9f5',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e3e0d5',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.selectedBackground': '#f0eee6',
    'editorHoverWidget.background': '#ffffff',
    'scrollbarSlider.background': '#1f1e1d18',
    'scrollbarSlider.hoverBackground': '#1f1e1d28',
    'scrollbarSlider.activeBackground': '#1f1e1d34',
    'minimap.background': '#faf9f5',
    'diffEditor.insertedTextBackground': '#2f8a4e2e',
    'diffEditor.removedTextBackground': '#c53a322e',
    'diffEditor.insertedLineBackground': '#2f8a4e14',
    'diffEditor.removedLineBackground': '#c53a3214',
    'diffEditor.diagonalFill': '#1f1e1d0a',
    'editorOverviewRuler.border': '#00000000'
  }
})

loader.config({ monaco })

const extMap = new Map<string, string>()
for (const lang of monaco.languages.getLanguages()) {
  for (const ext of lang.extensions ?? []) if (!extMap.has(ext.toLowerCase())) extMap.set(ext.toLowerCase(), lang.id)
}

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'dockerfile'
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return extMap.get(name.slice(dot)) ?? 'plaintext'
}

export const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 12,
  lineHeight: 18,
  fontLigatures: true,
  minimap: { enabled: true, scale: 1, renderCharacters: false, showSlider: 'mouseover' },
  smoothScrolling: true,
  cursorSmoothCaretAnimation: 'on',
  cursorBlinking: 'smooth',
  renderLineHighlight: 'all',
  scrollBeyondLastLine: false,
  padding: { top: 14, bottom: 14 },
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: 'active', indentation: true },
  stickyScroll: { enabled: true },
  automaticLayout: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  overviewRulerBorder: false,
  renderWhitespace: 'selection',
  tabSize: 2
}

export { monaco }
