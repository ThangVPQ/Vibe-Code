import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronRight, CircleCheck, CircleDashed, Clock, CornerDownLeft, Loader, MessageSquare, Mic, Paperclip, Plus, SquareTerminal, X } from 'lucide-react'
import type { ChatItem, ChatLog, ChatTodo } from '../../../shared/types'
import type { Chat } from '../store'
import { chatBoxFocus, menuShown, promptSuggestion, takeFiles } from '../terminals'
import { IMAGE_RE, imagePreview, pickAttachments } from '../attachments'
import { openFile } from '../actions'
import { AttachmentTray } from './AttachmentTray'
import { queuePrompt, sendMessage, sendQueuedNow, sentSeen, unqueue, usePromptQueue, useSentPrompts, type QueuedPrompt, type SentPrompt } from '../promptQueue'

const NO_QUEUE: QueuedPrompt[] = []
const NO_SENT: SentPrompt[] = []

type Tool = Extract<ChatItem, { kind: 'tool' }>

/** A chat's conversation, reloaded as its transcript grows (undefined while loading, null before there is one). */
export function useChatLog(sessionId: string | undefined): ChatLog | null | undefined {
  const [log, setLog] = useState<ChatLog | null | undefined>(null)
  useEffect(() => {
    setLog(sessionId ? undefined : null)
    if (!sessionId || typeof window.api.sessions.log !== 'function') return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      window.api.sessions
        .log(sessionId)
        .then((l) => {
          if (alive) setLog((prev) => (JSON.stringify(prev) === JSON.stringify(l) ? prev : l))
        })
        .catch(() => {})
    }
    load()
    const off = window.api.sessions.onChanged((ids) => {
      if (!ids.includes(sessionId) && !ids.includes('*')) return
      clearTimeout(timer)
      timer = setTimeout(load, 250)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [sessionId])
  return log
}

function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** 950 → 950, 12345 → 12.3k */
const tokens = (n: number): string => (n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`)

const base = (p: string): string => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1)

/** What a run of tool calls did, in one line: "Ran 5 commands, edited 2 files". */
function summary(tools: Tool[]): string {
  const counts = new Map<string, number>()
  const add = (k: string): void => void counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const t of tools) {
    if (t.name === 'Bash' || t.name === 'PowerShell') add('cmd')
    else if (t.name === 'Read') add('read')
    else if (t.name === 'Edit' || t.name === 'MultiEdit' || t.name === 'NotebookEdit') add('edit')
    else if (t.name === 'Write') add(tools.length === 1 ? 'write:' + base(t.label) : 'write')
    else if (t.name === 'Grep' || t.name === 'Glob') add('search')
    else if (t.name === 'WebFetch' || t.name === 'WebSearch') add('web')
    else if (t.name === 'Agent' || t.name === 'Task') add('agent')
    else if (t.name === 'ToolSearch') add('tools')
    else if (t.name.startsWith('mcp__')) add('mcp:' + t.name.split('__')[1])
    else add('use:' + t.name)
  }
  const n = (k: number, one: string, many: string): string => (k === 1 ? one : `${k} ${many}`)
  const parts = [...counts].map(([k, c]) => {
    if (k === 'cmd') return 'ran ' + n(c, 'a command', 'commands')
    if (k === 'read') return 'read ' + n(c, '1 file', 'files')
    if (k === 'edit') return 'edited ' + n(c, '1 file', 'files')
    if (k === 'write') return 'wrote ' + n(c, '1 file', 'files')
    if (k.startsWith('write:')) return 'created ' + k.slice(6)
    if (k === 'search') return 'searched ' + n(c, '1 pattern', 'patterns')
    if (k === 'web') return 'browsed ' + n(c, '1 page', 'pages')
    if (k === 'agent') return 'ran ' + n(c, 'an agent', 'agents')
    if (k === 'tools') return 'loaded tools'
    if (k.startsWith('mcp:')) return 'called ' + k.slice(4)
    return 'used ' + k.slice(4)
  })
  const s = parts.join(', ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* ---------------- markdown (what Claude writes) ---------------- */

function open(url: string): void {
  void window.api.app.openExternal(url)
}

/* ---------------- file paths: click to open in Source code ---------------- */

/** the chat's folder: relative paths are read against it */
const Cwd = createContext('')

/** C:\a\b.ts, \\server\x.png, src/a.ts, ./a.ts — optionally with :line; never the middle of a word or a URL */
const PATH_RE = /(?<![\w:/.\\-])(?:(?:[A-Za-z]:[\\/]|\\\\)[^\s`'"<>|*?]+|(?:\.{1,2}[\\/]|[\w@-][\w.@-]*[\\/])[\w.@\-\\/]*\.[A-Za-z][A-Za-z0-9]*(?::\d+)?)/g

/** A path as written → the file it names (null when it doesn't end in a file name with an extension). */
function filePath(raw: string, cwd: string): string | null {
  const p = raw.replace(/[.,;:)\]}]+$/, '').replace(/(:\d+)+$/, '')
  if (!/\.[A-Za-z][A-Za-z0-9]*$/.test(p)) return null
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(p)) return p
  return cwd.replace(/[\\/]+$/, '') + '\\' + p.replace(/^\.[\\/]/, '').replace(/\//g, '\\')
}

function PathLink({ raw, children }: { raw: string; children: React.ReactNode }): React.JSX.Element {
  const abs = filePath(raw, useContext(Cwd))
  if (!abs) return <>{children}</>
  return (
    <a
      className="cv-path"
      href="#"
      title={`Open ${abs} in Source code`}
      onClick={(e) => {
        e.preventDefault()
        openFile(abs)
      }}
    >
      {children}
    </a>
  )
}

/** Plain text with the file paths in it made clickable. */
function withPaths(text: string, key: number | string = 0): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(PATH_RE)) {
    // keep a sentence's full stop / closing bracket out of the link
    const raw = m[0].replace(/[.,;:)\]}]+$/, '')
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <PathLink key={`${key}-p${m.index}`} raw={raw}>
        {raw}
      </PathLink>
    )
    last = m.index + raw.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type Pic = { path: string; src: string }

/** Pictures on disk, loaded (as data: URLs) for showing; the ones that can't be read are left out. */
function usePics(paths: string[] | undefined): Pic[] {
  const sig = paths?.join('|') ?? ''
  const [pics, setPics] = useState<Pic[]>([])
  useEffect(() => {
    let live = true
    const list = sig ? sig.split('|') : []
    Promise.all(list.map((path) => imagePreview(path).then((src) => (src ? { path, src } : null)))).then(
      (r) => live && setPics(r.filter((x): x is Pic => !!x))
    )
    return () => {
      live = false
    }
  }, [sig])
  return pics
}

/** Small previews in a line (inside a row's header): they only show, the row does the clicking. */
function MiniPics({ paths, max = 4 }: { paths: string[] | undefined; max?: number }): React.JSX.Element | null {
  const pics = usePics(paths)
  if (!pics.length) return null
  return (
    <span className="cv-minipics">
      {pics.slice(0, max).map((p) => (
        <img key={p.path} src={p.src} alt="" draggable={false} />
      ))}
      {pics.length > max && <span className="cv-minipics-more">+{pics.length - max}</span>}
    </span>
  )
}

/** Pictures full width, one under the other; click one to see it at full size. */
function BigPics({ paths }: { paths: string[] | undefined }): React.JSX.Element | null {
  const pics = usePics(paths)
  const [zoom, setZoom] = useState<string | null>(null)
  if (!pics.length) return null
  return (
    <div className="cv-bigpics">
      {pics.map((p) => (
        <button key={p.path} className="cv-bigpic" title="Click to see it full size" onClick={() => setZoom(p.src)}>
          <img src={p.src} alt="" draggable={false} />
        </button>
      ))}
      {zoom && <Lightbox src={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="image-lightbox" onClick={onClose}>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
      <button className="lb-btn lb-close" title="Close (Esc)" onClick={onClose}>
        <X size={18} />
      </button>
    </div>
  )
}

/** Small previews; click one to open it big right below (click again to fold it). */
function Pics({ paths, end }: { paths: string[]; end?: boolean }): React.JSX.Element | null {
  const pics = usePics(paths)
  const [open, setOpen] = useState<string | null>(null)
  const shown = pics.find((p) => p.path === open)
  if (!pics.length) return null
  return (
    <div className={`cv-pics${end ? ' end' : ''}`}>
      <div className="cv-thumbs">
        {pics.map((p) => (
          <button
            key={p.path}
            className={`cv-thumb${p.path === open ? ' on' : ''}`}
            title={p.path === open ? 'Fold the picture' : 'Show the picture'}
            onClick={() => setOpen(p.path === open ? null : p.path)}
          >
            <img src={p.src} alt="" draggable={false} />
          </button>
        ))}
      </div>
      {shown && <BigPics paths={[shown.path]} />}
    </div>
  )
}

/** The pictures a message names, shown under it as small previews. */
function Thumbs({ text, end }: { text: string; end?: boolean }): React.JSX.Element | null {
  const cwd = useContext(Cwd)
  const paths = [...new Set([...text.matchAll(PATH_RE)].map((m) => filePath(m[0], cwd)).filter((p): p is string => !!p && IMAGE_RE.test(p)))]
  return <Pics paths={paths} end={end} />
}

/** What I sent: the pictures in it show as pictures only — their paths are left out of the text. */
function UserMessage({ text, cwd, sending }: { text: string; cwd: string; sending?: boolean }): React.JSX.Element {
  const shown = text
    .replace(PATH_RE, (m) => {
      const p = filePath(m, cwd)
      return p && IMAGE_RE.test(p) ? '' : m
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return (
    <div className={`cv-user-wrap${sending ? ' sending' : ''}`} title={sending ? 'Sent — Claude reads it as soon as it can' : undefined}>
      {shown && <div className="cv-user">{withPaths(shown)}</div>}
      <Thumbs text={text} end />
    </div>
  )
}

function inline(text: string, key = 0): React.ReactNode[] {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)<>]+)/g
  const out: React.ReactNode[] = []
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(...withPaths(text.slice(last, m.index), `${key}-${last}`))
    const k = `${key}-${m.index}`
    if (m[1]) {
      const code = m[1].slice(1, -1)
      const whole = code.match(PATH_RE)?.[0] === code.replace(/[.,;:)\]}]+$/, '')
      out.push(
        whole ? (
          <PathLink key={k} raw={code}>
            <code>{code}</code>
          </PathLink>
        ) : (
          <code key={k}>{code}</code>
        )
      )
    }
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), m.index)}</strong>)
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>)
    else if (m[4]) {
      const url = m[5]
      out.push(
        <a key={k} href={url} onClick={(e) => (e.preventDefault(), open(url))}>
          {m[4].slice(1, m[4].indexOf(']('))}
        </a>
      )
    } else if (m[6]) {
      const url = m[6]
      out.push(
        <a key={k} href={url} onClick={(e) => (e.preventDefault(), open(url))}>
          {url}
        </a>
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(...withPaths(text.slice(last), `${key}-${last}`))
  return out
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

function Markdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  let i = 0
  const startsBlock = (l: string): boolean => /^(```|#{1,6}\s|>|\|)/.test(l) || LIST_RE.test(l) || /^(-{3,}|\*{3,})\s*$/.test(l)
  while (i < lines.length) {
    const l = lines[i]
    const k = i
    if (!l.trim()) {
      i++
    } else if (l.startsWith('```')) {
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i])
      i++
      out.push(
        <pre key={k} className="md-code">
          {body.join('\n')}
        </pre>
      )
    } else if (/^#{1,6}\s/.test(l)) {
      const level = l.match(/^#+/)![0].length
      out.push(
        <div key={k} className={`md-h md-h${Math.min(level, 3)}`}>
          {inline(l.replace(/^#+\s+/, ''))}
        </div>
      )
      i++
    } else if (/^(-{3,}|\*{3,})\s*$/.test(l)) {
      out.push(<hr key={k} />)
      i++
    } else if (l.trimStart().startsWith('|') && /^\s*\|?[\s:|-]+$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const head = cells(l)
      const rows: string[][] = []
      for (i += 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++) rows.push(cells(lines[i]))
      out.push(
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>{r.map((c, n) => <td key={n}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    } else if (l.startsWith('>')) {
      const body: string[] = []
      for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^>\s?/, ''))
      out.push(
        <blockquote key={k}>
          <Markdown text={body.join('\n')} />
        </blockquote>
      )
    } else if (LIST_RE.test(l)) {
      const ordered = /\d/.test(l.match(LIST_RE)![2])
      const items: { depth: number; text: string; n: string }[] = []
      for (; i < lines.length; i++) {
        const m = lines[i].match(LIST_RE)
        if (m) items.push({ depth: Math.floor(m[1].length / 2), text: m[3], n: m[2] })
        // a wrapped item's next line
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) items[items.length - 1].text += ' ' + lines[i].trim()
        else break
      }
      out.push(
        <div key={k} className="md-list">
          {items.map((it, j) => (
            <div key={j} className="md-li" style={{ paddingLeft: 16 + it.depth * 16 }}>
              <span className="md-bullet">{ordered && /\d/.test(it.n) ? it.n.replace(')', '.') : '•'}</span>
              {inline(it.text)}
            </div>
          ))}
        </div>
      )
    } else {
      const body: string[] = []
      for (; i < lines.length && lines[i].trim() && (body.length === 0 || !startsBlock(lines[i])); i++) body.push(lines[i])
      out.push(<p key={k}>{inline(body.join('\n'))}</p>)
    }
  }
  return <div className="md">{out}</div>
}

/* ---------------- the conversation ---------------- */

function ToolRow({ t }: { t: Tool }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const short = t.name.startsWith('mcp__') ? t.name.split('__').slice(2).join('__') : t.name
  const isFile = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t.name) && !!t.label
  const label = isFile ? base(t.label) : t.label
  return (
    <div className={`cv-tool${t.error ? ' err' : ''}`}>
      <button className="cv-tool-head" onClick={() => setOpen(!open)} title={t.label}>
        <ChevronRight size={12} className={open ? 'task-chev open' : 'task-chev'} />
        <span className="cv-tool-name">{short}</span>
        {isFile ? (
          <span className="cv-tool-label">
            <span
              className="cv-path"
              title={`Open ${t.label} in Source code`}
              onClick={(e) => {
                e.stopPropagation()
                openFile(t.label)
              }}
            >
              {label}
            </span>
          </span>
        ) : (
          <span className="cv-tool-label">{label}</span>
        )}
        {t.added + t.removed > 0 && (
          <span className="cv-diff">
            {t.added > 0 && <span className="add">+{t.added}</span>}
            {t.removed > 0 && <span className="del">−{t.removed}</span>}
          </span>
        )}
        {t.output === undefined && <Loader size={12} className="task-spin" />}
        {!open && <MiniPics paths={t.images} />}
      </button>
      {open && (
        <div className="cv-tool-body">
          {t.detail && <pre className="task-out">{t.detail}</pre>}
          {t.images?.length ? (
            <BigPics paths={t.images} />
          ) : t.diff?.length && !t.error ? (
            <Diff lines={t.diff} />
          ) : (
            t.output !== undefined && <pre className="task-out">{t.output.trim() || 'No output.'}</pre>
          )}
        </div>
      )}
    </div>
  )
}

/** A Write / Edit's change: removed lines red, added green, numbered like the file. */
function Diff({ lines }: { lines: string[] }): React.JSX.Element {
  let oldN = 0
  let newN = 0
  return (
    <div className="cv-diff-view">
      {lines.map((l, i) => {
        const head = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/)
        if (head) {
          oldN = +head[1]
          newN = +head[2]
          return i ? <div key={i} className="cv-dl gap">⋯</div> : null
        }
        const kind = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''
        const n = kind === 'del' ? oldN : newN
        if (kind !== 'add') oldN++
        if (kind !== 'del') newN++
        return (
          <div key={i} className={`cv-dl ${kind}`}>
            <span className="cv-dl-n">{n}</span>
            <span className="cv-dl-s">{kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}</span>
            <span className="cv-dl-t">{l.slice(1)}</span>
          </div>
        )
      })}
    </div>
  )
}

function ToolGroup({ tools, live }: { tools: Tool[]; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const added = tools.reduce((n, t) => n + t.added, 0)
  const removed = tools.reduce((n, t) => n + t.removed, 0)
  const running = live && tools.some((t) => t.output === undefined)
  // no pictures on this line: the ones Claude looked at are mostly the ones I sent, already shown above
  return (
    <div className="cv-group">
      <button className="cv-group-head" onClick={() => setOpen(!open)}>
        {running && <Loader size={12} className="task-spin" />}
        <span>{summary(tools)}</span>
        {added > 0 && <span className="cv-diff"><span className="add">+{added}</span></span>}
        {removed > 0 && <span className="cv-diff"><span className="del">−{removed}</span></span>}
        <ChevronRight size={13} className={open ? 'task-chev open' : 'task-chev'} />
      </button>
      {open && (
        <div className="cv-group-body">
          {tools.map((t) => (
            <ToolRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function Todos({ todos }: { todos: ChatTodo[] }): React.JSX.Element {
  return (
    <div className="cv-todos">
      {todos.map((t) => (
        <div key={t.id + t.text} className={`cv-todo s-${t.status}`}>
          {t.status === 'completed' ? <CircleCheck size={14} /> : t.status === 'in_progress' ? <Loader size={14} className="task-spin" /> : <CircleDashed size={14} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

type Block = { key: string } & ({ kind: 'item'; item: Exclude<ChatItem, Tool> } | { kind: 'tools'; tools: Tool[] } | { kind: 'todos' })

function blocks(log: ChatLog): Block[] {
  const out: Block[] = []
  log.items.forEach((item, i) => {
    if (i === log.todosAt && log.todos.length) out.push({ key: 'todos', kind: 'todos' })
    const prev = out[out.length - 1]
    if (item.kind === 'tool') {
      if (prev?.kind === 'tools') prev.tools.push(item)
      else out.push({ key: item.id, kind: 'tools', tools: [item] })
    } else out.push({ key: `${i + log.skipped}`, kind: 'item', item })
  })
  if (log.todosAt >= log.items.length && log.todos.length) out.push({ key: 'todos', kind: 'todos' })
  return out
}

/** The Chat tab: the conversation drawn from the transcript, and a message box that types into Claude's terminal. */
export function ChatView({ chat, onTerminal }: { chat: Chat; onTerminal: () => void }): React.JSX.Element {
  const log = useChatLog(chat.sessionId)
  const sent = useSentPrompts((s) => s.byChat[chat.id] ?? NO_SENT)
  const working = chat.status === 'working'
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)

  // Claude waiting on a numbered choice: only its terminal can answer.
  // And the next prompt it suggests (dim in its input box): shown in ours, Tab takes it.
  const [asking, setAsking] = useState(false)
  const [suggested, setSuggested] = useState('')
  useEffect(() => {
    const check = (): void => {
      setAsking(menuShown(chat.id))
      setSuggested(promptSuggestion(chat.id))
    }
    check()
    const i = setInterval(check, 700)
    return () => clearInterval(i)
  }, [chat.id])

  // "Working… 1m 3s" is computed at render: tick while Claude works
  const [, tick] = useState(0)
  useEffect(() => {
    if (!working) return
    const i = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(i)
  }, [working])

  // follow the end of the conversation, unless you scrolled up to read
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [log, working, asking, sent])
  useEffect(() => {
    stick.current = true
    const el = box.current
    if (el && document.activeElement === el) chatBoxFocus(chat.id, true)
    el?.focus()
    // the box moves to another chat (or goes away) while focused: this chat's Claude is no longer typed into
    return () => {
      if (el && document.activeElement === el) chatBoxFocus(chat.id, false)
    }
  }, [chat.id])

  const queued = usePromptQueue((s) => s.byChat[chat.id] ?? NO_QUEUE)
  const send = (): void => {
    const text = draft.trim()
    if (!text || chat.status === 'exited' || chat.status === 'starting') return
    // Claude is busy: the message waits above the box (X takes it back, "Send now" sends it anyway)
    if (working) queuePrompt(chat.id, text)
    else sendMessage(chat.id, text)
    setDraft('')
    stick.current = true
  }
  /** X on a waiting message: back into the box (before what's being typed), cursor at its end */
  const takeBack = (id: string): void => {
    const item = unqueue(chat.id, id)
    if (!item) return
    const next = draft.trim() ? `${item.text}\n${draft}` : item.text
    setDraft(next)
    requestAnimationFrame(() => {
      const el = box.current
      if (!el) return
      el.focus()
      el.setSelectionRange(item.text.length, item.text.length)
    })
  }

  const suggestion = !draft && !working && chat.status !== 'exited' ? suggested : ''

  const items = log?.items ?? []
  // the turn started with the last prompt sent while idle (not one taken in mid-turn)
  const turnStart = [...items].reverse().find((it) => it.kind === 'user' && !it.mid)
  const lastDone = items.findLastIndex((it) => it.kind === 'done') + (log?.skipped ?? 0)
  const list = log ? blocks(log) : []
  // sent messages the transcript has caught up with: it writes each one down after it was typed, in order
  const seen = sent.length ? items.filter((it) => it.kind === 'user' && it.at >= sent[0].at).length : 0
  const sending = chat.status === 'exited' ? NO_SENT : sent.slice(seen)
  useEffect(() => {
    if (seen) sentSeen(chat.id, seen)
  }, [chat.id, seen])
  // a turn starts with a message sent while idle, even before the transcript has it
  const startAt = sending.find((p) => !p.mid)?.at ?? turnStart?.at

  return (
    <Cwd.Provider value={chat.cwd}>
      <div className="cv">
        <div
          className="cv-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {!list.length && !sending.length && (
            <div className="chat-images-empty">
              <MessageSquare size={22} />
              <p>{log === undefined ? 'Loading…' : 'Send a message to start. Everything Claude does in this chat shows up here; the Terminal tab has the full screen.'}</p>
            </div>
          )}
          {log && log.skipped > 0 && <div className="cv-note">Earlier messages are in the Terminal tab.</div>}
          {list.map((b, n) => (
            <Fragment key={b.key}>
              {b.kind === 'todos' && log && <Todos todos={log.todos} />}
              {b.kind === 'tools' && <ToolGroup tools={b.tools} live={working && n === list.length - 1} />}
              {b.kind === 'item' && b.item.kind === 'user' && (
                <UserMessage text={b.item.text} cwd={chat.cwd} />
              )}
              {b.kind === 'item' && b.item.kind === 'text' && (
                <>
                  <Markdown text={b.item.text} />
                  <Thumbs text={b.item.text} />
                </>
              )}
              {b.kind === 'item' && b.item.kind === 'done' && (
                <div className="cv-note">
                  {b.item.ms ? `Worked for ${dur(b.item.ms)}` : 'Interrupted'}
                  {!working && b.key === String(lastDone) && !!log?.outTokens && ` · ${tokens(log.outTokens)} tokens out in this chat`}
                </div>
              )}
            </Fragment>
          ))}
          {sending.map((p) => (
            <UserMessage key={`sent-${p.at}`} text={p.text} cwd={chat.cwd} sending />
          ))}
          {working && (
            <div className="cv-working">
              <Loader size={13} className="task-spin" />
              Working{startAt ? ` · ${dur(Date.now() - startAt)}` : '…'}
              {!!log?.turnOutTokens && <span title="Tokens Claude wrote in this turn">· ↓ {tokens(log.turnOutTokens)} tokens</span>}
              {!!log?.outTokens && <span className="cv-working-total" title="Tokens Claude wrote in this whole chat">· {tokens(log.outTokens)} in this chat</span>}
            </div>
          )}
          {asking && (
            <div className="cv-asking">
              <span>Claude is asking you to choose something.</span>
              <button className="btn btn-sm" onClick={onTerminal}>
                <SquareTerminal size={13} /> Answer in Terminal
              </button>
            </div>
          )}
        </div>
        {queued.length > 0 && (
          <div className="cv-queue">
            {queued.map((q) => (
              <div key={q.id} className="cv-queued">
                <Clock size={13} className="cv-queued-ic" />
                <span className="cv-queued-text" title={q.text}>
                  {q.text}
                </span>
                {q.files.length > 0 && (
                  <span className="cv-queued-files" title={q.files.map((f) => f.path).join('\n')}>
                    <Paperclip size={11} /> {q.files.length}
                  </span>
                )}
                <button className="cv-queued-send" title="Send it now — Claude reads it while it works" onClick={() => sendQueuedNow(chat.id, q.id)}>
                  <ArrowUp size={12} /> Send now
                </button>
                <button className="cv-queued-x" title="Take it back to the message box" onClick={() => takeBack(q.id)}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <AttachmentTray chatId={chat.id} className="cv-tray" refocus={() => box.current?.focus()} />
        <div className="cv-compose">
          <button
            className="cv-icon"
            title="Attach files — they go with your next message"
            disabled={chat.status === 'exited'}
            onClick={async () => {
              await pickAttachments(chat.id, chat.cwd)
              box.current?.focus()
            }}
          >
            <Plus size={17} />
          </button>
          <textarea
            ref={box}
            rows={1}
            value={draft}
            placeholder={chat.status === 'exited' ? 'This chat has ended' : suggestion || 'Message Claude (Enter to send, Shift+Enter for a new line)'}
            disabled={chat.status === 'exited'}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => chatBoxFocus(chat.id, true)}
            onBlur={() => chatBoxFocus(chat.id, false)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && suggestion && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault()
                setDraft(suggestion)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (!files.length) return
              e.preventDefault()
              void takeFiles(chat.id, 'claude', files)
            }}
          />
          {suggestion && (
            <button className="cv-tab-hint" title="Take Claude's suggestion (Tab)" onMouseDown={(e) => e.preventDefault()} onClick={() => {
                setDraft(suggestion)
                box.current?.focus()
              }}>
              Tab
            </button>
          )}
          <button className="cv-icon cv-send" title="Send (Enter)" disabled={!draft.trim() || chat.status === 'exited' || chat.status === 'starting'} onClick={send}>
            <CornerDownLeft size={16} />
          </button>
          <button
            className="cv-icon"
            title="Voice typing (Windows, Win+H)"
            disabled={chat.status === 'exited'}
            onClick={() => {
              box.current?.focus()
              void window.api.app.voiceTyping?.()
            }}
          >
            <Mic size={16} />
          </button>
        </div>
      </div>
    </Cwd.Provider>
  )
}
