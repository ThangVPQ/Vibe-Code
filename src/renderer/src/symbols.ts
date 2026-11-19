import type * as Monaco from 'monaco-editor'

/* "Go to Symbol in Editor" (Ctrl+Shift+O) for languages Monaco has no outline for.
 * TS/JS/CSS/HTML/JSON come with real providers; everything else gets a line-based
 * scan good enough to jump to functions, classes and the like. */

const BUILT_IN = new Set(['typescript', 'javascript', 'css', 'scss', 'less', 'html', 'handlebars', 'razor', 'json'])

type Kind = 'Function' | 'Method' | 'Class' | 'Interface' | 'Struct' | 'Enum' | 'Module' | 'Object' | 'Constant'

const KIND_OF: Record<string, Kind> = {
  fn: 'Function', func: 'Function', fun: 'Function', def: 'Function', function: 'Function', sub: 'Function',
  procedure: 'Function', proc: 'Function', trigger: 'Function',
  class: 'Class', record: 'Class', object: 'Object', view: 'Object', table: 'Struct',
  interface: 'Interface', trait: 'Interface', protocol: 'Interface',
  struct: 'Struct', type: 'Struct', union: 'Struct',
  enum: 'Enum',
  mod: 'Module', module: 'Module', namespace: 'Module', package: 'Module', impl: 'Module',
  const: 'Constant', static: 'Constant'
}

// keyword-led declarations: `pub async fn x`, `export class X`, `def x`, `CREATE OR ALTER PROCEDURE dbo.x` …
const DECL =
  /^\s*(?:(?:pub(?:\([^)]*\))?|export|default|public|private|protected|internal|static|abstract|final|sealed|open|override|virtual|async|unsafe|extern(?:\s+"[^"]*")?|inline|partial|data|suspend|declare|local|readonly)\s+)*(fn|func|fun|def|function|sub|class|record|object|interface|trait|protocol|struct|union|enum|mod|module|namespace|impl|type|const|static)\b\s*(?:<[^>]*>\s*)?(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)/
const SQL = /^\s*create\s+(?:or\s+(?:alter|replace)\s+)?(procedure|proc|function|view|table|trigger|type)\s+([\w.[\]"`]+)/i
// C-family methods: `public static int Foo(…)` / `void Bar::baz(…) {` — a type, a name, a parameter list, not a call
const METHOD = /^\s*(?:[\w$<>[\],.?*&:]+\s+)+\**&?([A-Za-z_$][\w$]*(?:::~?[A-Za-z_$][\w$]*)?)\s*\([^;]*$/
const NOT_METHOD = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'new', 'else', 'using', 'lock', 'throw', 'await', 'yield', 'sizeof', 'typeof', 'delete', 'case', 'when', 'do', 'in', 'is', 'and', 'or', 'not'])
const SHELL = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#(?!include|define|region)|--|;|')/

const C_LIKE = new Set(['csharp', 'java', 'c', 'cpp', 'objective-c', 'php', 'dart', 'kotlin', 'scala', 'swift', 'apex'])
const SHELLISH = new Set(['shell', 'powershell', 'bat'])

export function scanSymbols(lines: string[], lang: string): { name: string; kind: Kind; line: number; col: number }[] {
  const out: { name: string; kind: Kind; line: number; col: number }[] = []
  const sql = lang === 'sql' || lang === 'mysql' || lang === 'pgsql'
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (text.length > 400 || COMMENT.test(text)) continue
    let m: RegExpExecArray | null
    let name: string | undefined
    let kind: Kind | undefined
    if (sql) {
      if ((m = SQL.exec(text))) (name = m[2]), (kind = KIND_OF[m[1].toLowerCase()])
    } else if ((m = DECL.exec(text))) {
      const kw = m[1]
      // `type`/`const`/`static` are also plain statements in many languages: only keep obvious declarations
      if ((kw === 'const' || kw === 'static') && !/^\s*(?:pub\S*\s+)?(?:const|static)\s+(?:mut\s+)?[A-Z_][A-Z0-9_]*\s*:/.test(text)) continue
      name = m[2]
      kind = KIND_OF[kw]
    } else if (SHELLISH.has(lang) && (m = SHELL.exec(text)) && !NOT_METHOD.has(m[1])) {
      ;(name = m[1]), (kind = 'Function')
    } else if (lang === 'powershell' && (m = /^\s*function\s+([\w-]+)/i.exec(text))) {
      ;(name = m[1]), (kind = 'Function')
    } else if (C_LIKE.has(lang) && (m = METHOD.exec(text)) && !NOT_METHOD.has(m[1].toLowerCase())) {
      // skip calls and assignments such as `foo = bar(` / `return x(`
      if (/=|\b(?:return|new|await|throw|yield|else)\b/.test(text.slice(0, text.indexOf(m[1])))) continue
      ;(name = m[1]), (kind = 'Method')
    }
    if (name && kind) out.push({ name, kind, line: i + 1, col: text.indexOf(name) + 1 })
  }
  return out
}

export function registerFallbackSymbols(monaco: typeof Monaco): void {
  const ids = monaco.languages
    .getLanguages()
    .map((l) => l.id)
    .filter((id) => !BUILT_IN.has(id))
  monaco.languages.registerDocumentSymbolProvider(ids, {
    displayName: 'VIBE CODE outline',
    provideDocumentSymbols(model) {
      const found = scanSymbols(model.getLinesContent(), model.getLanguageId())
      return found.map((s, i) => {
        // a symbol spans until the next one starts, so the outline/breadcrumbs know where you are
        const endLine = Math.max(s.line, (found[i + 1]?.line ?? model.getLineCount() + 1) - 1)
        return {
          name: s.name,
          detail: '',
          kind: monaco.languages.SymbolKind[s.kind],
          tags: [],
          range: new monaco.Range(s.line, 1, endLine, model.getLineMaxColumn(endLine)),
          selectionRange: new monaco.Range(s.line, s.col, s.line, s.col + s.name.length)
        }
      })
    }
  })
}
