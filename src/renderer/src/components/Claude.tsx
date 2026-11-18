import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Image as ImageIcon, MessageSquare, Copy, Download, GitCommitHorizontal, Shield, ShieldOff, History, Plus, RefreshCw, RotateCcw, Sparkles, Play, FastForward, Upload, SquareTerminal, Trash2, X, ExternalLink } from 'lucide-react'
import { useStore, type Chat } from '../store'
import { SlidePill, useEnterAnimation } from './motion'
import {
  closeChat,
  closeShell,
  detectClaude,
  newChat,
  newShell,
  restartChat,
  selectChat,
  setChatEffort,
  setChatModel,
  setChatPermission,
  folderKey,
  loadProjectBypass,
  toggleProjectBypass
} from '../actions'
import { attachTerm, detachTerm, fitTerm, focusTerm, writeToTerm } from '../terminals'
import { Logo, StatusDot, statusLabel } from './icons'
import { ChatImages, useChatImages } from './ChatImages'

export function TerminalView({ id, autoFocus = true }: { id: string; autoFocus?: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current!
    attachTerm(id, el, autoFocus)
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fitTerm(id))
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      detachTerm(id)
    }
  }, [id, autoFocus])
  return <div className="term-view" ref={ref} onMouseDown={() => setTimeout(() => focusTerm(id), 0)} />
}

/* ================================ Claude panel ================================ */

/** One click: Claude commits everything and pushes, following our commit-message rules. */
const COMMIT_PUSH =
  'Commit all current changes and push to the remote. Commit message rules: English, one short subject line only ' +
  '(no body or description), and no Co-Authored-By or any other author/attribution trailer.\r'

const PULL =
  'Pull the latest code from the remote for the current branch (git pull). If there are local changes or conflicts, ' +
  'keep my work safe and tell me what happened.\r'

export function ClaudePanel(): JSX.Element {
  const chats = useStore((s) => s.chats)
  const activeId = useStore((s) => s.activeChatId)
  const claude = useStore((s) => s.claude)
  const active = chats.find((c) => c.id === activeId) ?? null
  const images = useChatImages(active?.sessionId)
  const [tab, setTab] = useState<'chat' | 'images'>('chat')
  // another chat opens on its Chat tab
  useEffect(() => setTab('chat'), [activeId])
  // switching chats: the new conversation eases in
  const termFrame = useRef<HTMLDivElement>(null)
  useEnterAnimation(termFrame, activeId)

  // Chats are picked from the sidebar, so there is no tab strip here — just the open chat's title row.
  return (
    <div className="claude-panel">
      {claude && !claude.found && <InstallCard />}
      {claude?.found && !active && <NoChat />}

      {active && (
        <>
          <div className="chat-titlebar">
            <div className="chat-titlebar-main">
              <StatusDot status={active.status} attention={active.attention} />
              <span className="chat-titlebar-title">{active.title}</span>
              <span className={`chat-state s-${active.status}`}>{statusLabel[active.status]}</span>
            </div>
            <div className="chat-titlebar-actions">
              {active.status === 'exited' && (
                <button className="btn btn-ghost btn-sm" onClick={() => restartChat(active.id)}>
                  <RefreshCw size={13} /> Restart
                </button>
              )}
              <BypassProjectButton chat={active} />
              <button className="icon-btn accent" title="New chat (Ctrl+Shift+N)" onClick={() => newChat()}>
                <Plus size={16} />
              </button>
              <button className="icon-btn" title="Close chat (it stays in the sidebar history)" onClick={() => closeChat(active.id)}>
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="code-side-switch chat-tabs">
            <SlidePill />
            <button
              className={tab === 'chat' ? 'on' : ''}
              onClick={() => {
                setTab('chat')
                setTimeout(() => focusTerm(active.id), 0)
              }}
            >
              <MessageSquare size={13} /> Chat
            </button>
            <button className={tab === 'images' ? 'on' : ''} onClick={() => setTab('images')}>
              <ImageIcon size={13} /> Images
              {images.length > 0 && <span className="center-count">{images.length}</span>}
            </button>
          </div>
          {/* the terminal stays mounted (just hidden) so Claude keeps running and nothing redraws */}
          <div className="term-frame" ref={termFrame} style={tab === 'chat' ? undefined : { display: 'none' }}>
            <TerminalView id={active.id} />
          </div>
          {tab === 'images' && <ChatImages images={images} />}
          <div className="quick-bar">
            <button
              className="chip"
              title="Ask Claude to commit all changes (English subject line, no description, no co-author) and push"
              onClick={() => {
                setTab('chat')
                writeToTerm(active.id, COMMIT_PUSH)
                focusTerm(active.id)
              }}
            >
              <GitCommitHorizontal size={12} />
              Commit + push
            </button>
            <button
              className="chip"
              title="Ask Claude to pull the latest code from the remote"
              onClick={() => {
                setTab('chat')
                writeToTerm(active.id, PULL)
                focusTerm(active.id)
              }}
            >
              <Download size={12} />
              Pull
            </button>
          </div>
          <ChatStatusBar chat={active} />
          <ContextBar chat={active} />
        </>
      )}
    </div>
  )
}

/** One click: Claude never asks for permission anywhere in this chat's project. */
function BypassProjectButton({ chat }: { chat: Chat }): JSX.Element {
  const on = useStore((s) => !!s.projectBypass[folderKey(chat.cwd)])
  useEffect(() => {
    loadProjectBypass(chat.cwd)
  }, [chat.cwd])
  return (
    <button
      className={`btn btn-sm bypass-btn${on ? ' on' : ''}`}
      title={on ? `Bypass is on for ${chat.cwd} — click to turn off` : `Bypass permissions for the whole project ${chat.cwd}`}
      onClick={() => toggleProjectBypass(chat.id)}
    >
      {on ? <ShieldOff size={13} /> : <Shield size={13} />}
      {on ? 'Project bypassed' : 'Bypass project'}
    </button>
  )
}

/* ---------------- Model / effort / permission pickers ---------------- */

interface Opt {
  value: string
  label: string
  hint?: string
}

const MODELS: Opt[] = [
  { value: '', label: 'Default', hint: "Claude Code's choice" },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Most capable' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Fast, strong' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'Fastest' },
  { value: 'claude-fable-5-2', label: 'Fable 5.2' }
]

const EFFORTS: Opt[] = [
  { value: '', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

const MODES: Opt[] = [
  { value: '', label: 'Ask permissions', hint: 'Default' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Auto-approve file edits' },
  { value: 'plan', label: 'Plan mode', hint: 'Read-only planning' },
  { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'No prompts at all' }
]

/** One-click prompts for the chat's project. */
const ACTIONS = [
  {
    key: 'continue',
    label: 'Continue',
    icon: <FastForward size={12} />,
    title: 'Tell Claude to continue where it stopped',
    prompt: 'continue',
    confirm: ''
  },
  {
    key: 'run',
    label: 'Run App',
    icon: <Play size={12} />,
    title: 'Ask Claude to start this project and give you the local URL',
    prompt:
      "Run this project's app the usual way for this project (backend and frontend if both are needed). Keep it running in the background, check that it responds, and give me the local URL.",
    confirm: ''
  },
  {
    key: 'publish',
    label: 'Publish BE',
    icon: <Upload size={12} />,
    title: 'Ask Claude to build and publish the backend',
    prompt:
      "Publish this project's backend: build it in Release and publish it the way this project is set up to (publish profile or script). Tell me where the output went and whether anything failed.",
    confirm: 'Ask Claude to publish the backend of this project now?'
  }
]

function sendPrompt(id: string, text: string): void {
  writeToTerm(id, text)
  // a separate Enter, so Claude doesn't read it as part of a pasted block
  setTimeout(() => writeToTerm(id, '\r'), 150)
  focusTerm(id)
}

function ChatStatusBar({ chat }: { chat: Chat }): JSX.Element {
  const exited = chat.status === 'exited'
  return (
    <div className="chat-statusbar">
      <div className="sb-actions">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            className="chip sb-action"
            title={exited ? 'This chat has ended — restart it first' : `${a.label} — ${a.title}`}
            aria-label={a.label}
            disabled={exited}
            onClick={() => {
              if (a.confirm && !window.confirm(a.confirm)) return
              sendPrompt(chat.id, a.prompt)
            }}
          >
            {a.icon}
          </button>
        ))}
      </div>
      <Picker title="Model" options={MODELS} value={chat.model ?? ''} onPick={(v) => setChatModel(chat.id, v)} />
      <Picker title="Effort" options={EFFORTS} value={chat.effort ?? ''} onPick={(v) => setChatEffort(chat.id, v)} />
      <Picker
        title="Permission mode (restarts the chat)"
        options={MODES}
        value={chat.permissionMode ?? ''}
        warn={chat.permissionMode === 'bypassPermissions'}
        onPick={(v) => setChatPermission(chat.id, v)}
      />
      {(chat.status === 'working' || chat.status === 'starting') && <span className="sb-spinner" title="Working" />}
    </div>
  )
}

/** How full this chat's context window is, from the last reply in its session file. */
function ContextBar({ chat }: { chat: Chat }): JSX.Element {
  const sessionId = chat.sessionId
  const [ctx, setCtx] = useState<{ used: number; model: string } | null>(null)
  useEffect(() => {
    setCtx(null)
    if (!sessionId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      window.api.sessions
        .context(sessionId)
        .then((c) => alive && setCtx(c))
        .catch(() => {})
    }
    load()
    const off = window.api.sessions.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(load, 400)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [sessionId])

  const used = ctx?.used ?? 0
  // Opus 5.5 (and any `[1m]` model) has a 1M window; others 200k unless already past it
  const models = `${chat.model ?? ''} ${ctx?.model ?? ''}`
  const max = /opus-5-5|\[1m\]/i.test(models) || used > 200_000 ? 1_000_000 : 200_000
  const pct = Math.min(100, (used / max) * 100)
  const level = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low'
  const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
  return (
    <div className="ctx-bar" title={ctx ? `${used.toLocaleString()} of ${max.toLocaleString()} tokens in context` : 'No reply yet'}>
      <span className="ctx-label">Context</span>
      <div className="ctx-track">
        <div className={`ctx-fill ${level}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="ctx-num">
        {ctx ? `${k(used)} / ${k(max)} · ${Math.round(pct)}%` : '—'}
      </span>
    </div>
  )
}

function Picker(props: { title: string; options: Opt[]; value: string; warn?: boolean; onPick: (v: string) => void }): JSX.Element {
  const { title, options, value, warn, onPick } = props
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  const cur = options.find((o) => o.value === value) ?? options[0]
  return (
    <div className="sb-picker" ref={ref}>
      <button className={`sb-btn${open ? ' open' : ''}${warn ? ' warn' : ''}`} title={title} onClick={() => setOpen(!open)}>
        {cur.label}
      </button>
      {open && (
        <div className="sb-menu" role="menu">
          <div className="sb-menu-title">{title}</div>
          {options.map((o) => (
            <button
              key={o.value}
              role="menuitemradio"
              aria-checked={o.value === value}
              className={`sb-item${o.value === value ? ' on' : ''}`}
              onClick={() => {
                setOpen(false)
                if (o.value !== value) onPick(o.value)
              }}
            >
              <Check size={13} className="sb-check" />
              <span className="sb-item-label">{o.label}</span>
              {o.hint && <span className="sb-item-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NoChat(): JSX.Element {
  return (
    <div className="no-chat">
      <div className="glow-orb">
        <Logo size={56} />
      </div>
      <h3>What should we build?</h3>
      <p>Each chat runs its own Claude Code session in this folder. Run several in parallel and hop between them.</p>
      <div className="no-chat-actions">
        <button className="btn btn-primary btn-lg" onClick={() => newChat()}>
          <Sparkles size={16} /> New chat
        </button>
        <button className="btn btn-ghost" onClick={() => newChat({ args: ['--continue'], title: 'Continued chat' })}>
          <RotateCcw size={14} /> Continue last
        </button>
        <button className="btn btn-ghost" onClick={() => newChat({ args: ['--resume'], title: 'Resume…' })}>
          <History size={14} /> Resume…
        </button>
      </div>
    </div>
  )
}

function InstallCard(): JSX.Element {
  const cmd = 'npm install -g @anthropic-ai/claude-code'
  return (
    <div className="no-chat">
      <div className="glow-orb dim">
        <Logo size={56} />
      </div>
      <h3>Claude Code isn't installed</h3>
      <p>VIBE CODE runs the <code>claude</code> command-line tool. Install it, then sign in once from a terminal.</p>
      <div className="code-line">
        <code>{cmd}</code>
        <button className="icon-btn" title="Copy" onClick={() => navigator.clipboard.writeText(cmd)}>
          <Copy size={14} />
        </button>
      </div>
      <div className="no-chat-actions">
        <button
          className="btn btn-primary"
          onClick={() => {
            newShell()
            setTimeout(() => {
              const id = useStore.getState().activeShellId
              if (id) writeToTerm(id, cmd + '\r')
            }, 900)
          }}
        >
          <SquareTerminal size={15} /> Install in terminal
        </button>
        <button className="btn btn-ghost" onClick={() => detectClaude()}>
          <RefreshCw size={14} /> I've installed it
        </button>
        <button className="btn btn-ghost" onClick={() => window.api.app.openExternal('https://docs.claude.com/en/docs/claude-code/setup')}>
          <ExternalLink size={14} /> Docs
        </button>
      </div>
    </div>
  )
}

/* ================================ Bottom terminal panel ================================ */

export function BottomPanel(): JSX.Element {
  const shells = useStore((s) => s.shells)
  const activeId = useStore((s) => s.activeShellId)
  return (
    <div className="bottom-panel">
      <div className="bottom-header">
        <div className="bottom-tabs">
          <span className="bottom-label">Terminal</span>
          <SlidePill />
          {shells.map((sh) => (
            <button
              key={sh.id}
              className={`bottom-tab${sh.id === activeId ? ' active' : ''}${sh.exited ? ' exited' : ''}`}
              onClick={() => useStore.setState({ activeShellId: sh.id })}
            >
              <SquareTerminal size={13} />
              <span>{sh.title}</span>
              <X
                size={12}
                className="bottom-tab-x"
                onClick={(e) => {
                  e.stopPropagation()
                  closeShell(sh.id)
                }}
              />
            </button>
          ))}
        </div>
        <div className="section-actions">
          <button className="icon-btn" title="New terminal" onClick={() => newShell()}>
            <Plus size={15} />
          </button>
          {activeId && (
            <button className="icon-btn" title="Kill terminal" onClick={() => closeShell(activeId)}>
              <Trash2 size={14} />
            </button>
          )}
          <button className="icon-btn" title="Hide panel (Ctrl+`)" onClick={() => useStore.setState({ bottomOpen: false })}>
            <ChevronDown size={15} />
          </button>
        </div>
      </div>
      <div className="term-frame bottom">{activeId && <TerminalView id={activeId} />}</div>
    </div>
  )
}
