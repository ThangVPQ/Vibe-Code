import { execFile } from 'child_process'
import { existsSync } from 'fs'
import type { WebContents } from 'electron'
import * as pty from '@lydell/node-pty'
import { win32 } from 'path'
import type { AgentInfo, ClaudeInfo, PtySpawnOptions } from '../shared/types'
import { AGENTS, agentDef } from '../shared/agents'
import { mcpConfigFor } from './browserMcp'

const sessions = new Map<string, pty.IPty>()

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    execFile(finder, [cmd], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      resolve(first ?? null)
    })
  })
}

let shellCache: string | null = null
async function defaultShell(): Promise<string> {
  if (shellCache) return shellCache
  if (process.platform !== 'win32') {
    shellCache = process.env.SHELL || '/bin/bash'
    return shellCache
  }
  shellCache = (await which('pwsh.exe')) ?? 'powershell.exe'
  return shellCache
}

export async function detectClaude(): Promise<ClaudeInfo> {
  const shell = await defaultShell()
  let path = await which('claude')
  if (!path && process.platform === 'win32') {
    const home = process.env.USERPROFILE ?? ''
    const candidates = [`${home}\\.local\\bin\\claude.exe`, `${process.env.APPDATA}\\npm\\claude.cmd`]
    path = candidates.find((p) => existsSync(p)) ?? null
  }
  return { found: !!path, path, shell }
}

/** Which coding agents (Claude, Codex, Grok, Gemini…) are installed. */
export async function detectAgents(): Promise<AgentInfo[]> {
  return Promise.all(AGENTS.map(async (a) => ({ id: a.id, found: !!(await which(a.cmd)) })))
}

function quoteArg(a: string): string {
  return /^[\w\-./:=]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`
}

/**
 * When the app itself was started from inside a Claude Code session, that session's variables
 * (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, plugin dirs, the host's API URL…) would leak into every
 * chat: Claude then treats it as a child session and stops saving transcripts. Chats should start
 * like `claude` typed in a fresh terminal, so drop them.
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (!env.CLAUDECODE && !env.CLAUDE_CODE_SESSION_ID) return env
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE$|CLAUDE_|MCP_)/.test(k) || k === 'ANTHROPIC_BASE_URL') delete env[k]
  }
  return env
}

export async function spawnPty(wc: WebContents, opts: PtySpawnOptions): Promise<void> {
  killPty(opts.id)
  const shell = await defaultShell()
  const isWin = process.platform === 'win32'
  let args: string[] = []

  if (opts.kind === 'claude') {
    const agent = agentDef(opts.agent)
    // the chat's own Web tab as MCP tools (Claude only); last, because --mcp-config takes several values
    const mcp = agent.id === 'claude' ? mcpConfigFor(opts.id) : null
    const claudeCmd = [agent.cmd, ...(opts.claudeArgs ?? []), ...(mcp ? ['--mcp-config', mcp] : [])].map(quoteArg).join(' ')
    // Run claude inside an interactive shell so that when it exits the user lands in a shell
    // in the same folder instead of a dead pane.
    args = isWin ? ['-NoLogo', '-NoExit', '-Command', claudeCmd] : ['-lc', `${claudeCmd}; exec ${shell}`]
  } else {
    args = isWin ? ['-NoLogo'] : ['-l']
  }

  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: Math.max(2, opts.cols),
    rows: Math.max(2, opts.rows),
    // Claude Code keys folder trust by the exact path: `E:/x` and `E:\x` count as different
    // folders, so always hand it the native Windows form or it asks to trust the folder again.
    cwd: isWin ? win32.resolve(opts.cwd) : opts.cwd,
    env: { ...cleanEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' } as Record<string, string>
  })
  sessions.set(opts.id, proc)
  const dbg = !!process.env.STUDIO_DEBUG_SCRIPT
  if (dbg) console.log('[pty] spawn', opts.id, shell, JSON.stringify(args), opts.cols, opts.rows, 'pid', proc.pid)
  let logged = 0

  // Claude Code redraws in many tiny chunks; one IPC message per chunk floods the renderer and
  // makes the chat stutter. Gather what arrives within a few ms and send it as one piece.
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending) return
    const out = pending
    pending = ''
    if (!wc.isDestroyed()) wc.send('pty:data', opts.id, out)
  }
  proc.onData((data) => {
    if (dbg && logged++ < 3) console.log('[pty] data', opts.id, JSON.stringify(data.slice(0, 160)))
    pending += data
    if (pending.length > 256 * 1024) flush()
    else if (!timer) timer = setTimeout(flush, 5)
  })
  proc.onExit(({ exitCode }) => {
    if (dbg) console.log('[pty] exit', opts.id, exitCode)
    flush()
    // A process we killed or replaced (restart) must not report "exited": the chat id already
    // belongs to a new, live process, and marking it ended would block typing into it.
    if (sessions.get(opts.id) !== proc) return
    sessions.delete(opts.id)
    if (!wc.isDestroyed()) wc.send('pty:exit', opts.id, exitCode)
  })
}

/** false when there is no live process for this id (it died without us hearing about it) */
export function writePty(id: string, data: string): boolean {
  const p = sessions.get(id)
  if (!p) return false
  try {
    p.write(data)
    return true
  } catch {
    sessions.delete(id)
    return false
  }
}

export function resizePty(id: string, cols: number, rows: number): void {
  const p = sessions.get(id)
  if (!p) return
  try {
    p.resize(Math.max(2, cols), Math.max(2, rows))
  } catch {
    /* process may have exited */
  }
}

export function killPty(id: string): void {
  const p = sessions.get(id)
  if (!p) return
  sessions.delete(id)
  try {
    p.kill()
  } catch {
    /* already dead */
  }
}

export function killAll(): void {
  for (const id of [...sessions.keys()]) killPty(id)
}
