import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronRight, CircleCheck, CircleDashed, Loader, MessageSquare, SquareTerminal } from 'lucide-react'
import type { ChatItem, ChatLog, ChatTodo } from '../../../shared/types'
import type { Chat } from '../store'
import { menuShown, sendPrompt, takeFiles } from '../terminals'

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

function inline(text: string, key = 0): React.ReactNode[] {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)<>]+)/g
  const out: React.ReactNode[] = []
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${m.index}`
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>)
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
  if (last < text.length) out.push(text.slice(last))
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
  const label = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t.name) ? base(t.label) : t.label
  return (
    <div className={`cv-tool${t.error ? ' err' : ''}`}>
      <button className="cv-tool-head" onClick={() => setOpen(!open)} title={t.label}>
        <ChevronRight size={12} className={open ? 'task-chev open' : 'task-chev'} />
        <span className="cv-tool-name">{short}</span>
        <span className="cv-tool-label">{label}</span>
        {t.added + t.removed > 0 && (
          <span className="cv-diff">
            {t.added > 0 && <span className="add">+{t.added}</span>}
            {t.removed > 0 && <span className="del">−{t.removed}</span>}
          </span>
        )}
        {t.output === undefined && <Loader size={12} className="task-spin" />}
      </button>
      {open && (
        <div className="cv-tool-body">
          {t.detail && <pre className="task-out">{t.detail}</pre>}
          {t.output !== undefined && <pre className="task-out">{t.output.trim() || 'No output.'}</pre>}
        </div>
      )}
    </div>
  )
}

function ToolGroup({ tools, live }: { tools: Tool[]; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const added = tools.reduce((n, t) => n + t.added, 0)
  const removed = tools.reduce((n, t) => n + t.removed, 0)
  const running = live && tools.some((t) => t.output === undefined)
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
  const working = chat.status === 'working'
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)

  // Claude waiting on a numbered choice: only its terminal can answer
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    const check = (): void => setAsking(menuShown(chat.id))
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
  }, [log, working, asking])
  useEffect(() => {
    stick.current = true
    box.current?.focus()
  }, [chat.id])

  const send = (): void => {
    const text = draft.trim()
    if (!text || chat.status === 'exited' || chat.status === 'starting') return
    sendPrompt(chat.id, text)
    setDraft('')
    stick.current = true
  }

  const items = log?.items ?? []
  const lastUser = [...items].reverse().find((it) => it.kind === 'user')
  const list = log ? blocks(log) : []

  return (
    <div className="cv">
      <div
        className="cv-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {!list.length && (
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
            {b.kind === 'item' && b.item.kind === 'user' && <div className="cv-user">{b.item.text}</div>}
            {b.kind === 'item' && b.item.kind === 'text' && <Markdown text={b.item.text} />}
            {b.kind === 'item' && b.item.kind === 'done' && <div className="cv-note">{b.item.ms ? `Worked for ${dur(b.item.ms)}` : 'Interrupted'}</div>}
          </Fragment>
        ))}
        {working && (
          <div className="cv-working">
            <Loader size={13} className="task-spin" />
            Working{lastUser ? ` · ${dur(Date.now() - lastUser.at)}` : '…'}
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
      <div className="cv-compose">
        <textarea
          ref={box}
          rows={1}
          value={draft}
          placeholder={chat.status === 'exited' ? 'This chat has ended' : 'Message Claude (Enter to send, Shift+Enter for a new line)'}
          disabled={chat.status === 'exited'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
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
        <button className="cv-send" title="Send (Enter)" disabled={!draft.trim() || chat.status === 'exited' || chat.status === 'starting'} onClick={send}>
          <ArrowUp size={15} />
        </button>
      </div>
    </div>
  )
}
