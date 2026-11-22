import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FileText, Gauge, Image as ImageIcon, ListChecks, MessageSquare, Monitor, Copy, Download, GitCommitHorizontal, Shield, ShieldOff, History, Plus, RefreshCw, RotateCcw, Sparkles, Play, FastForward, Upload, Paperclip, Square, SquareTerminal, Trash2, X, ExternalLink } from 'lucide-react'
import { useStore, type Chat } from '../store'
import { SlidePill, useEnterAnimation } from './motion'
import {
  closeChat,
  closeShell,
  defaultAgent,
  detectClaude,
  newChat,
  newChatWith,
  newShell,
  restartChat,
  selectChat,
  setChatEffort,
  setChatModel,
  setChatPermission,
  disabledTools,
  setDisabledTools,
  folderKey,
  loadProjectBypass,
  toggleProjectBypass,
  toggleDesktop
} from '../actions'
import { attachTerm, detachTerm, fitTerm, focusTerm, writeToTerm } from '../terminals'
import { Logo, StatusDot, statusLabel } from './icons'
import { ChatImages, useChatImages } from './ChatImages'
import { ChatTasks, useChatTasks } from './ChatTasks'
import { ChatFiles, useChatFiles } from './ChatFiles'
import { ChatTitle, chatMenu } from './Sidebar'
import { AttachmentTray } from './AttachmentTray'
import { pickAttachments } from '../attachments'
import { NewChatMenu } from './AgentMenu'
import { AGENTS, agentDef } from '../../../shared/agents'

export function TerminalView({ id, autoFocus = true }: { id: string; autoFocus?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current!
    attachTerm(id, el, autoFocus)
    // A fit that changes the column count re-wraps the whole scrollback: while a panel is dragged,
    // at most ~12 a second (the last size always gets one), not one every frame.
    let raf = 0
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (): void => {
      last = performance.now()
      fitTerm(id)
    }
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      const wait = 80 - (performance.now() - last)
      if (wait <= 0) raf = requestAnimationFrame(run)
      else timer = setTimeout(() => (raf = requestAnimationFrame(run)), wait)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      clearTimeout(timer)
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

export function ClaudePanel(): React.JSX.Element {
  // only the open chat: other chats' status / title changes don't re-render this panel
  const active = useStore((s) => s.chats.find((c) => c.id === s.activeChatId) ?? null)
  const activeId = active?.id ?? null
  const claude = useStore((s) => s.claude)
  // Codex / Gemini… alone is enough to chat; the install card is for when no agent is there at all
  const anyAgent = useStore((s) => !!s.claude?.found || s.agents.some((a) => a.found))
  const images = useChatImages(active?.sessionId)
  const tasks = useChatTasks(active?.sessionId)
  const runningTasks = tasks.filter((t) => t.status === 'running').length
  const files = useChatFiles(active?.sessionId)
  const changedFiles = files.filter((f) => f.action !== 'read').length
  const [tab, setTab] = useState<'chat' | 'images' | 'files' | 'tasks'>('chat')
  // another chat opens on its Chat tab
  useEffect(() => setTab('chat'), [activeId])
  // the terminal stays under Images / Files / Tasks, so it must not keep the keyboard
  const leaveChat = (t: 'images' | 'files' | 'tasks'): void => {
    const el = document.activeElement
    if (el instanceof HTMLElement && termFrame.current?.contains(el)) el.blur()
    setTab(t)
  }
  // switching chats: the new conversation eases in
  const termFrame = useRef<HTMLDivElement>(null)
  useEnterAnimation(termFrame, activeId)

  // the bar over the quick actions: moving while the chat works, green once that run has finished
  const busy = active?.status === 'working' || active?.status === 'starting'
  const [done, setDone] = useState(false)
  const wasBusy = useRef(false)
  useEffect(() => {
    wasBusy.current = false
    setDone(false)
  }, [activeId])
  useEffect(() => {
    if (busy) setDone(false)
    else if (wasBusy.current && active?.status === 'idle') setDone(true)
    wasBusy.current = busy
  }, [busy, active?.status])

  // Chats are picked from the sidebar, so there is no tab strip here — just the open chat's title row.
  return (
    <div className="claude-panel">
      {claude && !anyAgent && <InstallCard />}
      {anyAgent && !active && <NoChat />}

      {active && (
        <>
          <div className="chat-titlebar">
            <div className="chat-titlebar-main" onContextMenu={(e) => chatMenu(e, { chatId: active.id }, 'title')}>
              <StatusDot status={active.status} attention={active.attention} />
              <ChatTitle place="title" chatId={active.id} title={active.title} className="chat-titlebar-title" />
              {agentDef(active.agent).id !== 'claude' && <span className="chat-agent">{agentDef(active.agent).label}</span>}
              <span className={`chat-state s-${active.status}`}>{statusLabel[active.status]}</span>
            </div>
            <div className="chat-titlebar-actions">
              {active.status === 'exited' && (
                <button className="btn btn-ghost btn-sm" onClick={() => restartChat(active.id)}>
                  <RefreshCw size={13} /> Restart
                </button>
              )}
              {agentDef(active.agent).id === 'claude' && <BypassProjectButton chat={active} />}
              <NewChatMenu title="New chat with the default agent (Ctrl+Shift+N) — right-click to pick another AI" onPick={newChatWith} />
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
            <button className={tab === 'images' ? 'on' : ''} onClick={() => leaveChat('images')}>
              <ImageIcon size={13} /> Images
              {images.length > 0 && <span className="center-count">{images.length}</span>}
            </button>
            <button className={tab === 'files' ? 'on' : ''} title="Files Claude created, edited or read in this chat" onClick={() => leaveChat('files')}>
              <FileText size={13} /> Files
              {changedFiles > 0 && <span className="center-count">{changedFiles}</span>}
            </button>
            <button className={tab === 'tasks' ? 'on' : ''} title="Background tasks Claude started in this chat" onClick={() => leaveChat('tasks')}>
              <ListChecks size={13} /> Tasks
              {runningTasks > 0 ? <span className="center-count running">{runningTasks}</span> : tasks.length > 0 && <span className="center-count">{tasks.length}</span>}
            </button>
          </div>
          {/*
            The terminal stays mounted and laid out (only made invisible): display:none would reset
            xterm's scroll position to the top of the buffer and replay the enter animation on return.
            Images / Tasks cover it instead.
          */}
          <div className="term-frame" ref={termFrame}>
            <div className="term-layer" style={tab === 'chat' ? undefined : { visibility: 'hidden' }}>
              <TerminalView id={active.id} />
            </div>
            <StartSkeleton show={active.status === 'starting'} />
            {tab !== 'chat' && (
              <div className="chat-overlay">
                {tab === 'images' ? <ChatImages images={images} /> : tab === 'files' ? <ChatFiles files={files} cwd={active.cwd} /> : <ChatTasks tasks={tasks} />}
              </div>
            )}
          </div>
          <AttachmentTray chatId={active.id} />
          <div className={`quick-bar${busy ? ' busy' : done ? ' done' : ''}`}>
            {active.status === 'working' && (
              <button
                className="chip chip-stop"
                title="Stop what the AI is doing (Esc)"
                onClick={() => {
                  setTab('chat')
                  writeToTerm(active.id, '\x1b')
                  focusTerm(active.id)
                }}
              >
                <Square size={10} fill="currentColor" />
                Stop
              </button>
            )}
            <button
              className="chip"
              title="Attach files — they go with your next message (you can also paste pictures or drag files onto the chat)"
              disabled={active.status === 'exited'}
              onClick={async () => {
                setTab('chat')
                await pickAttachments(active.id, active.cwd)
                focusTerm(active.id)
              }}
            >
              <Paperclip size={12} />
              <span className="chip-label">Attach files</span>
            </button>
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
              <span className="chip-label">Commit + push</span>
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
              <span className="chip-label">Pull</span>
            </button>
            {agentDef(active.agent).id === 'claude' && <TokenButton chat={active} />}
            {agentDef(active.agent).id === 'claude' && window.api.platform === 'win32' && (
              <button
                className={`chip${active.desktop ? ' on' : ''}`}
                title={
                  active.desktop
                    ? 'Claude can see and control the other apps on this computer in this chat. Click to turn it off.'
                    : 'Let Claude see and control the other apps on this computer (mouse and keyboard) in this chat. The chat restarts (same conversation); new chats keep it on until you turn it off.'
                }
                onClick={() => void toggleDesktop(active.id)}
              >
                <Monitor size={12} />
                <span className="chip-label">Desktop control</span>
              </button>
            )}
          </div>
          <ChatStatusBar chat={active} />
          {agentDef(active.agent).id === 'claude' && <ContextBar chat={active} />}
        </>
      )}
    </div>
  )
}

/** Until the agent draws its first screen: a shimmering outline of its banner and prompt, faded out once it has. */
function StartSkeleton({ show }: { show: boolean }): React.JSX.Element | null {
  const [mounted, setMounted] = useState(show)
  useEffect(() => {
    if (show) return setMounted(true)
    const t = setTimeout(() => setMounted(false), 260)
    return () => clearTimeout(t)
  }, [show])
  if (!mounted) return null
  return (
    <div className={`chat-skel${show ? '' : ' out'}`} aria-hidden>
      <div className="chat-skel-head">
        <span className="sk sk-logo" />
        <div className="chat-skel-lines">
          <span className="sk" style={{ width: '38%' }} />
          <span className="sk" style={{ width: '62%' }} />
          <span className="sk" style={{ width: '28%' }} />
        </div>
      </div>
      <div className="chat-skel-prompt">
        <span className="sk sk-rule" />
        <span className="sk" style={{ width: '46%' }} />
        <span className="sk sk-rule" />
        <span className="sk" style={{ width: '34%' }} />
      </div>
    </div>
  )
}

/** One click: Claude never asks for permission anywhere in this chat's project. */
function BypassProjectButton({ chat }: { chat: Chat }): React.JSX.Element {
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
      <span className="bypass-label">{on ? 'Project bypassed' : 'Bypass project'}</span>
    </button>
  )
}

/** Tools Claude can't do much without: turning them off is allowed, but flagged. */
const CORE_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ToolSearch', 'Skill'])

/** Pick tools to take out of Claude chats: their definitions stop filling the context. */
function TokenButton({ chat }: { chat: Chat }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [tools, setTools] = useState<{ name: string; tokens: number }[]>([])
  const [off, setOff] = useState<Set<string>>(new Set())
  const [pos, setPos] = useState({ left: 0, bottom: 0 })
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

  const saved = disabledTools()
  const show = (btn: HTMLElement): void => {
    // fixed, not inside the quick bar: that one scrolls sideways and would clip the menu
    const r = btn.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), bottom: window.innerHeight - r.top + 6 })
    setOff(new Set(saved))
    setTools([])
    if (chat.sessionId)
      window.api.sessions
        .context(chat.sessionId)
        .then((c) => setTools(c?.tools ?? []))
        .catch(() => {})
    setOpen(true)
  }
  // tools already off aren't in the chat's requests any more: listed after the rest, size unknown
  const rows = [...tools, ...saved.filter((n) => !tools.some((t) => t.name === n)).map((name) => ({ name, tokens: 0 }))]
  const saving = tools.filter((t) => off.has(t.name)).reduce((n, t) => n + t.tokens, 0)
  const changed = off.size !== saved.length || saved.some((n) => !off.has(n))
  const fmt = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)
  const toggle = (name: string): void =>
    setOff((s) => {
      const next = new Set(s)
      if (!next.delete(name)) next.add(name)
      return next
    })

  return (
    <div className="tok-wrap" ref={ref}>
      <button
        className={`chip${saved.length ? ' on' : ''}`}
        title="Turn off tools you don't use, so their definitions stop taking up the context"
        onClick={(e) => (open ? setOpen(false) : show(e.currentTarget))}
      >
        <Gauge size={12} />
        <span className="chip-label">Optimize tokens</span>
        {saved.length > 0 && <span className="tok-count">{saved.length} off</span>}
      </button>
      {open && (
        <div className="tok-menu" style={{ left: pos.left, bottom: pos.bottom }} role="menu">
          <div className="sb-menu-title">Tick the tools to turn off (all Claude chats)</div>
          <div className="tok-list">
            {rows.length === 0 && <div className="tok-empty">{chat.sessionId ? 'Loading…' : 'Send a message first to see the tools.'}</div>}
            {rows.map((t) => (
              <label key={t.name} className={`tok-row${off.has(t.name) ? ' on' : ''}`}>
                <input type="checkbox" checked={off.has(t.name)} onChange={() => toggle(t.name)} />
                <span className="tok-name">{t.name}</span>
                {CORE_TOOLS.has(t.name) && <span className="tok-core" title="Claude relies on this tool for everyday work">core</span>}
                <span className="tok-size">{t.tokens ? fmt(t.tokens) : 'off'}</span>
              </label>
            ))}
          </div>
          <div className="tok-foot">
            <span>{saving > 0 ? `Saves ~${fmt(saving)} tokens` : ''}</span>
            <button
              className="btn btn-primary btn-sm"
              disabled={!changed}
              onClick={() => {
                setOpen(false)
                setDisabledTools(chat.id, [...off])
              }}
            >
              Apply & restart chat
            </button>
          </div>
        </div>
      )}
    </div>
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

function ChatStatusBar({ chat }: { chat: Chat }): React.JSX.Element {
  const exited = chat.status === 'exited'
  const agent = agentDef(chat.agent)
  const isClaude = agent.id === 'claude'
  // other agents: only "ask" vs their own never-ask flag (Codex --dangerously-bypass…, Gemini --yolo…)
  const modes = isClaude ? MODES : agent.yolo.length ? MODES.filter((m) => !m.value || m.value === 'bypassPermissions') : []
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
            onClick={async () => {
              if (a.confirm && !(await window.api.ask(a.confirm))) return
              sendPrompt(chat.id, a.prompt)
            }}
          >
            {a.icon}
          </button>
        ))}
      </div>
      {isClaude && <Picker title="Model" options={MODELS} value={chat.model ?? ''} onPick={(v) => setChatModel(chat.id, v)} />}
      {isClaude && <Picker title="Effort" options={EFFORTS} value={chat.effort ?? ''} onPick={(v) => setChatEffort(chat.id, v)} />}
      {modes.length > 0 && (
        <Picker
          title="Permission mode (restarts the chat)"
          options={modes}
          value={chat.permissionMode ?? ''}
          warn={chat.permissionMode === 'bypassPermissions'}
          onPick={(v) => setChatPermission(chat.id, v)}
        />
      )}
    </div>
  )
}

/**
 * Models with a 200k context window: Haiku 4.5 and everything before the 4.6 generation
 * (claude-haiku-4-5-20251001, claude-opus-4-20250514, claude-3-…). Every newer model — Fable,
 * Opus 4.6+, Sonnet 4.6+, Haiku 5.5 and ones not released yet — has 1M.
 */
const SMALL_WINDOW = /-(opus|sonnet|haiku)-4(-[0-5])?(-\d{8})?$|claude-[23]/i

/** What the context is made of (keys as sessions.rs sends them), in the bar's order. */
const CTX_PARTS: { key: string; label: string; hint: string }[] = [
  { key: 'system', label: 'System prompt', hint: "Claude Code's instructions, environment, date" },
  { key: 'tools', label: 'Built-in tools', hint: 'Bash, Read, Edit… and the deferred-tool list' },
  { key: 'mcp', label: 'MCP servers', hint: 'Tools and instructions of MCP servers' },
  { key: 'plugins', label: 'Plugins', hint: "Plugins' skills, agents and MCP tools" },
  { key: 'skills', label: 'Skills', hint: 'Skill list, plus skills Claude loaded' },
  { key: 'agents', label: 'Agents', hint: 'Subagent types for the Agent tool' },
  { key: 'memory', label: 'Memory files', hint: 'CLAUDE.md, MEMORY.md' },
  { key: 'messages', label: 'Messages', hint: 'Your messages, replies, tool calls and results' }
]

/** How full this chat's context window is, from the last reply in its session file. */
function ContextBar({ chat }: { chat: Chat }): React.JSX.Element {
  const sessionId = chat.sessionId
  const [ctx, setCtx] = useState<{ used: number; model: string; parts: { key: string; tokens: number }[] } | null>(null)
  const [hover, setHover] = useState(false)
  useEffect(() => {
    setCtx(null)
    if (!sessionId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      window.api.sessions
        .context(sessionId)
        .then((c) => alive && setCtx((prev) => (prev && c && prev.used === c.used && prev.model === c.model ? prev : c)))
        .catch(() => {})
    }
    load()
    const off = window.api.sessions.onChanged((ids) => {
      if (!ids.includes(sessionId) && !ids.includes('*')) return
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
  // the model that wrote the last reply decides (it follows a /model typed in the chat); the
  // `[1m]` suffix only exists on the launch flag. A 200k model already past 200k is on 1M too.
  const small = SMALL_WINDOW.test(ctx?.model || chat.model || '') && !/\[1m\]/i.test(chat.model ?? '')
  const max = small && used <= 200_000 ? 200_000 : 1_000_000
  const pct = Math.min(100, (used / max) * 100)
  const level = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low'
  const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
  const kk = (n: number): string => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : k(n))
  const pc = (n: number): string => {
    const p = (n / max) * 100
    return p > 0 && p < 0.1 ? '<0.1%' : `${p.toFixed(p < 10 ? 1 : 0)}%`
  }
  const tokens = new Map(ctx?.parts?.map((p) => [p.key, p.tokens]))
  const parts = CTX_PARTS.map((p) => ({ ...p, tokens: tokens.get(p.key) ?? 0 }))
  return (
    <div
      className="ctx-bar"
      title={ctx ? undefined : 'No reply yet'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="ctx-label">Context</span>
      <div className="ctx-track">
        {parts.map(
          (p) => p.tokens > 0 && <div key={p.key} className={`ctx-seg ctx-${p.key}`} style={{ width: `${(p.tokens / max) * 100}%` }} />
        )}
      </div>
      <span className={`ctx-num ${level}`}>{ctx ? `${k(used)} / ${k(max)} · ${Math.round(pct)}%` : '—'}</span>
      {hover && ctx && (
        <div className="ctx-pop">
          <div className="ctx-pop-head">
            <span>Context window</span>
            <span>
              {used.toLocaleString()} / {max.toLocaleString()} · {Math.round(pct)}%
            </span>
          </div>
          {parts.map((p) => (
            <div key={p.key} className={`ctx-row${p.tokens ? '' : ' none'}`} title={p.hint}>
              <i className={`ctx-dot ctx-${p.key}`} />
              <span className="ctx-row-label">{p.label}</span>
              <span className="ctx-row-num">{kk(p.tokens)}</span>
              <span className="ctx-row-pct">{pc(p.tokens)}</span>
            </div>
          ))}
          <div className="ctx-row free">
            <i className="ctx-dot" />
            <span className="ctx-row-label">Free space</span>
            <span className="ctx-row-num">{kk(Math.max(0, max - used))}</span>
            <span className="ctx-row-pct">{pc(Math.max(0, max - used))}</span>
          </div>
          <div className="ctx-pop-note">Estimated from the session file · total is exact</div>
        </div>
      )}
    </div>
  )
}

function Picker(props: { title: string; options: Opt[]; value: string; warn?: boolean; onPick: (v: string) => void }): React.JSX.Element {
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
      <button className={`sb-btn${open ? ' open' : ''}${warn ? ' warn' : ''}`} title={`${cur.label} — ${title}`} onClick={() => setOpen(!open)}>
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

function NoChat(): React.JSX.Element {
  const agents = useStore((s) => s.agents)
  const claudeFound = useStore((s) => !!s.claude?.found)
  useStore((s) => s.preferredAgent)
  const def = agentDef(defaultAgent())
  const others = AGENTS.filter((a) => a.id !== def.id && (a.id === 'claude' ? claudeFound : agents.some((x) => x.id === a.id && x.found)))
  return (
    <div className="no-chat">
      <div className="glow-orb">
        <Logo size={56} />
      </div>
      <h3>What should we build?</h3>
      <p>Each chat runs its own {def.label} session in this folder. Run several in parallel and hop between them.</p>
      <div className="no-chat-actions">
        <button className="btn btn-primary btn-lg" onClick={() => newChat()}>
          <Sparkles size={16} /> New chat{def.id !== 'claude' ? ` · ${def.label}` : ''}
        </button>
        {claudeFound && (
          <>
            <button className="btn btn-ghost" onClick={() => newChat({ args: ['--continue'], title: 'Continued chat' })}>
              <RotateCcw size={14} /> Continue last
            </button>
            <button className="btn btn-ghost" onClick={() => newChat({ args: ['--resume'], title: 'Resume…' })}>
              <History size={14} /> Resume…
            </button>
          </>
        )}
      </div>
      {others.length > 0 && (
        <div className="no-chat-actions no-chat-agents">
          {others.map((a) => (
            <button key={a.id} className="btn btn-ghost btn-sm" onClick={() => newChatWith(a.id)}>
              <Plus size={13} /> {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function InstallCard(): React.JSX.Element {
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

export function BottomPanel(): React.JSX.Element {
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
