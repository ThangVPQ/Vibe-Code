import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { PtySpawnOptions } from '../../shared/types'

export const termTheme: ITheme = {
  background: '#222a44',
  foreground: '#e4e4ee',
  cursor: '#8aa5ee',
  cursorAccent: '#222a44',
  selectionBackground: '#6f8fe64d',
  black: '#2b3554',
  red: '#ff6b6b',
  green: '#5fd38d',
  yellow: '#f5c76b',
  blue: '#6aa7ff',
  magenta: '#c49bff',
  cyan: '#5fd4e0',
  white: '#d6d6e2',
  brightBlack: '#7883a6',
  brightRed: '#ff8a8a',
  brightGreen: '#7fe3a6',
  brightYellow: '#ffd88a',
  brightBlue: '#8dbcff',
  brightMagenta: '#d7b8ff',
  brightCyan: '#86e6ee',
  brightWhite: '#ffffff'
}

export const termThemeLight: ITheme = {
  background: '#f7f8fc',
  foreground: '#161c2e',
  cursor: '#4a6fd8',
  cursorAccent: '#f7f8fc',
  selectionBackground: '#6f8fe63d',
  black: '#1f1e1d',
  red: '#c53a32',
  green: '#2f8a4e',
  yellow: '#a8741a',
  blue: '#2f6fd6',
  magenta: '#8a46c2',
  cyan: '#1d8396',
  white: '#8a877d',
  brightBlack: '#6f6d66',
  brightRed: '#d9534a',
  brightGreen: '#3aa15f',
  brightYellow: '#c08a26',
  brightBlue: '#4a86e8',
  brightMagenta: '#a463d6',
  brightCyan: '#2a9bb0',
  brightWhite: '#3d3c38'
}

let currentTheme: ITheme = termTheme
/** see-through mode: the terminal paints no background, the panel behind it does */
let clearBg = false

const shownTheme = (): ITheme => (clearBg ? { ...currentTheme, background: '#00000000' } : currentTheme)

/** Switch every open terminal (and future ones) between the dark and light palettes. */
export function setTerminalTheme(light: boolean): void {
  currentTheme = light ? termThemeLight : termTheme
  for (const e of entries.values()) e.term.options.theme = shownTheme()
}

export function setTerminalClear(clear: boolean): void {
  if (clear === clearBg) return
  clearBg = clear
  for (const e of entries.values()) e.term.options.theme = shownTheme()
}

/* ---- hide Claude Code's "bypass permissions on (shift+tab to cycle)" footer line ---- */

const FOOTER_RE = /bypass permissions on/i
const footerCover = new WeakMap<Entry, HTMLDivElement>()
const footerPending = new WeakSet<Entry>()

function scheduleFooterHide(e: Entry): void {
  if (footerPending.has(e)) return
  footerPending.add(e)
  requestAnimationFrame(() => {
    footerPending.delete(e)
    hideFooter(e)
  })
}

/**
 * Lay a background-coloured strip over that footer row. Only the last few rows of the screen are
 * checked, so the same words inside Claude's answers stay visible. Nothing is removed from the
 * output itself (that would break Claude's own screen redraws).
 */
function hideFooter(e: Entry): void {
  const b = e.term.buffer.active
  let row = -1
  for (let r = e.term.rows - 1; r >= Math.max(0, e.term.rows - 6); r--) {
    if (FOOTER_RE.test(b.getLine(b.viewportY + r)?.translateToString(true) ?? '')) {
      row = r
      break
    }
  }
  // the cover is a plain div over the terminal screen, placed on that row (xterm's own
  // decorations didn't show over the WebGL canvas)
  const screen = e.el.querySelector<HTMLElement>('.xterm-screen')
  let cover = footerCover.get(e)
  if (row < 0 || !screen) {
    if (cover) cover.style.display = 'none'
    return
  }
  if (!cover || cover.parentElement !== screen) {
    cover?.remove()
    cover = document.createElement('div')
    cover.className = 'term-footer-cover'
    screen.appendChild(cover)
    footerCover.set(e, cover)
  }
  const cellH = screen.clientHeight / e.term.rows
  cover.style.cssText = `position:absolute;left:0;right:0;top:${row * cellH}px;height:${Math.ceil(cellH)}px;z-index:20;pointer-events:none;background:${currentTheme.background ?? '#222a44'};`
}

interface Entry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  spawn: Omit<PtySpawnOptions, 'cols' | 'rows'>
  spawned: boolean
  webgl?: WebglAddon
  /** size last sent to the process, so a fit that changes nothing doesn't make Claude redraw */
  sent?: string
  resizeTimer?: ReturnType<typeof setTimeout>
}

type ActivityFn = (id: string) => void
type TitleFn = (id: string, title: string) => void
type ExitFn = (id: string, code: number) => void
type DataFn = (id: string, data: string) => void
type LinkFn = (id: string, url: string) => void

const entries = new Map<string, Entry>()

/* Terminal font size: Ctrl + / Ctrl − / Ctrl 0 in any terminal, shared by all, remembered. */
const FONT_KEY = 'tinjs.termFontSize'
const FONT_DEFAULT = 12
const FONT_MIN = 9
const FONT_MAX = 22
let fontSize = ((): number => {
  try {
    const n = Number(localStorage.getItem(FONT_KEY))
    return n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEFAULT
  } catch {
    return FONT_DEFAULT
  }
})()

export function setTermFontSize(size: number): void {
  const next = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(size)))
  if (next === fontSize) return
  fontSize = next
  try {
    localStorage.setItem(FONT_KEY, String(next))
  } catch {
    /* storage unavailable */
  }
  for (const e of entries.values()) {
    e.term.options.fontSize = next
    doFit(e)
  }
}

type InputFn = (id: string, data: string) => boolean
const handlers: { activity?: ActivityFn; title?: TitleFn; exit?: ExitFn; data?: DataFn; link?: LinkFn; input?: InputFn } = {}

let parking: HTMLDivElement | null = null
function parkingLot(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement('div')
    parking.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:400px;visibility:hidden;'
    document.body.appendChild(parking)
  }
  return parking
}

let wired = false
function wire(): void {
  if (wired) return
  wired = true
  window.api.pty.onData((id, data) => {
    const e = entries.get(id)
    if (!e) return
    e.term.write(data, () => scheduleFooterHide(e))
    handlers.activity?.(id)
    handlers.data?.(id, data)
  })
  window.api.pty.onExit((id, code) => {
    const e = entries.get(id)
    // -1 = found dead on a keystroke; the chat restarts right away, so no note
    if (e && code !== -1) e.term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
    handlers.exit?.(id, code)
  })
}

export function onTerminalEvents(h: { activity?: ActivityFn; title?: TitleFn; exit?: ExitFn; data?: DataFn; link?: LinkFn; input?: InputFn }): void {
  Object.assign(handlers, h)
}

export function createTerm(spawn: Omit<PtySpawnOptions, 'cols' | 'rows'>): void {
  wire()
  if (entries.has(spawn.id)) return
  const openLink = (url: string): void => {
    if (!/^https?:\/\//i.test(url)) return
    if (handlers.link) handlers.link(spawn.id, url)
    else window.api.app.openExternal(url)
  }
  const term = new Terminal({
    // OSC 8 hyperlinks (Claude Code underlines URLs this way): same route as plain-text links,
    // instead of xterm's default confirm() + window.open, which ended up in the external browser
    linkHandler: { activate: (_e, url) => openLink(url), allowNonHttpProtocols: false },
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    fontSize,
    lineHeight: 1.1,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    allowProposedApi: true,
    scrollback: 10000,
    smoothScrollDuration: 90,
    theme: shownTheme(),
    allowTransparency: true,
    macOptionIsMeta: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // clicked links go to the app (a chat's own Web tab); external browser only as a fallback
  term.loadAddon(new WebLinksAddon((_e, url) => openLink(url)))
  const uni = new Unicode11Addon()
  term.loadAddon(uni)
  term.unicode.activeVersion = '11'

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    const ctrl = ev.ctrlKey || ev.metaKey
    if (ctrl && !ev.shiftKey && ev.key.toLowerCase() === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    // Ctrl+A selects everything in the terminal (then Ctrl+C copies). Home still jumps to line start.
    if (ctrl && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'a') {
      term.selectAll()
      return false
    }
    // Ctrl + / Ctrl − / Ctrl 0: terminal font size
    if (ctrl && !ev.altKey && (ev.key === '=' || ev.key === '+')) {
      setTermFontSize(fontSize + 1)
      return false
    }
    if (ctrl && !ev.altKey && ev.key === '-') {
      setTermFontSize(fontSize - 1)
      return false
    }
    if (ctrl && !ev.altKey && ev.key === '0') {
      setTermFontSize(FONT_DEFAULT)
      return false
    }
    // Let the browser fire a native paste event, which xterm turns into bracketed paste.
    if (ctrl && ev.key.toLowerCase() === 'v') return false
    // Shift+Enter → newline inside Claude's prompt (ESC + CR, same as Meta+Enter)
    if (ev.key === 'Enter' && ev.shiftKey && !ctrl) {
      window.api.pty.write(spawn.id, '\x1b\r')
      return false
    }
    return true
  })

  term.onData((d) => {
    // the handler may take the keystroke instead (e.g. to restart an ended chat)
    if (handlers.input?.(spawn.id, d)) return
    window.api.pty.write(spawn.id, d)
  })
  term.onTitleChange((t) => handlers.title?.(spawn.id, t))

  const el = document.createElement('div')
  el.className = 'xterm-host'
  parkingLot().appendChild(el)
  term.open(el)

  // Ctrl+V with an image on the clipboard: save it and hand Claude the file path.
  el.addEventListener(
    'paste',
    (ev) => {
      const img = [...(ev.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (!img) return
      ev.preventDefault()
      ev.stopPropagation()
      sendImage(spawn.id, img)
    },
    true
  )
  // Drop files (images or anything else) onto the chat → their paths go into the prompt.
  el.addEventListener('dragover', (ev) => ev.preventDefault())
  el.addEventListener('drop', (ev) => {
    ev.preventDefault()
    for (const f of ev.dataTransfer?.files ?? []) {
      const p = window.api.app.pathFor(f)
      if (p) writeToTerm(spawn.id, quotePath(p) + ' ')
      else if (f.type.startsWith('image/')) sendImage(spawn.id, f)
    }
    term.focus()
  })
  // Right-click: copy the selection, or paste when nothing is selected.
  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    if (term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
    } else pasteInto(spawn.id)
  })

  const entry: Entry = { term, fit, el, spawn, spawned: false }
  entries.set(spawn.id, entry)
  // keep the footer cover on the right row when scrolling or resizing
  term.onScroll(() => scheduleFooterHide(entry))
  term.onResize(() => scheduleFooterHide(entry))
}

function doFit(e: Entry): void {
  const parent = e.el.parentElement
  if (!parent || parent === parking || parent.clientWidth < 20 || parent.clientHeight < 20) return
  try {
    e.fit.fit()
  } catch {
    return
  }
  if (e.spawned) sendSize(e)
}

/**
 * Every resize makes Claude Code repaint its whole screen (and ConPTY reflow it), so while a panel
 * is being dragged or animated, only the final size goes to the process.
 */
function sendSize(e: Entry): void {
  clearTimeout(e.resizeTimer)
  e.resizeTimer = setTimeout(() => {
    const size = `${e.term.cols}x${e.term.rows}`
    if (size === e.sent) return
    e.sent = size
    window.api.pty.resize(e.spawn.id, e.term.cols, e.term.rows)
  }, 120)
}

/**
 * Chromium allows only a handful of live WebGL contexts per page (the Web tab uses some too).
 * When one runs out, the oldest terminal's canvas is lost and it freezes or goes blank mid-output,
 * so a terminal holds its context only while it is on screen.
 */
function loadWebgl(e: Entry): void {
  if (e.webgl) return
  try {
    const gl = new WebglAddon()
    gl.onContextLoss(() => {
      gl.dispose()
      if (e.webgl === gl) e.webgl = undefined
      // still showing: get a fresh context instead of staying on the slow fallback renderer
      setTimeout(() => {
        if (e.el.parentElement && e.el.parentElement !== parking) loadWebgl(e)
      }, 500)
    })
    e.term.loadAddon(gl)
    e.webgl = gl
  } catch {
    /* falls back to DOM renderer */
  }
}

export function attachTerm(id: string, container: HTMLElement, focus = true): void {
  const e = entries.get(id)
  if (!e) return
  container.appendChild(e.el)
  loadWebgl(e)
  // setTimeout, not requestAnimationFrame: rAF is paused while the window is hidden or
  // minimized, which would leave a new chat stuck at "Starting…" with no process.
  setTimeout(() => {
    doFit(e)
    if (!e.spawned) {
      e.spawned = true
      e.sent = `${e.term.cols}x${e.term.rows}`
      window.api.pty.spawn({ ...e.spawn, cols: e.term.cols, rows: e.term.rows })
    }
    if (focus) e.term.focus()
  }, 0)
}

export function detachTerm(id: string): void {
  const e = entries.get(id)
  if (!e || e.el.parentElement === parking) return
  parkingLot().appendChild(e.el)
  e.webgl?.dispose()
  e.webgl = undefined
}

export function fitTerm(id: string): void {
  const e = entries.get(id)
  if (e) doFit(e)
}

export function focusTerm(id: string): void {
  entries.get(id)?.term.focus()
}

const quotePath = (p: string): string => (/\s/.test(p) ? `"${p}"` : p)

/** Attach button: pick files from disk → their paths go into the prompt (Claude reads them by path). */
export async function attachFiles(id: string, cwd?: string): Promise<void> {
  // (missing until the app restarts after an update)
  if (typeof window.api.app.pickFiles !== 'function') return
  const paths = await window.api.app.pickFiles(cwd).catch(() => [] as string[])
  if (paths.length) writeToTerm(id, paths.map(quotePath).join(' ') + ' ')
  focusTerm(id)
}

async function sendImage(id: string, file: Blob): Promise<void> {
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
  const path = await window.api.app.saveImage(new Uint8Array(await file.arrayBuffer()), ext)
  writeToTerm(id, quotePath(path) + ' ')
  focusTerm(id)
}

/** Paste button / right-click: an image if the clipboard holds one, else text. */
export async function pasteInto(id: string): Promise<void> {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) return sendImage(id, await item.getType(type))
    }
  } catch {
    /* clipboard.read can refuse; fall back to text */
  }
  const text = await navigator.clipboard.readText().catch(() => '')
  const e = entries.get(id)
  if (text && e) e.term.paste(text)
  focusTerm(id)
}

/** Copy button: the selection, or the whole visible screen when nothing is selected. */
export function copyFrom(id: string): void {
  const e = entries.get(id)
  if (!e) return
  const text = e.term.hasSelection() ? e.term.getSelection() : readScreen(id)
  navigator.clipboard.writeText(text)
  e.term.clearSelection()
  focusTerm(id)
}

export function writeToTerm(id: string, text: string): void {
  window.api.pty.write(id, text)
}

export function restartTerm(id: string, spawn?: Partial<Omit<PtySpawnOptions, 'cols' | 'rows'>>): void {
  const e = entries.get(id)
  if (!e) return
  e.spawn = { ...e.spawn, ...spawn }
  e.term.reset()
  e.sent = `${e.term.cols}x${e.term.rows}`
  window.api.pty.spawn({ ...e.spawn, cols: e.term.cols, rows: e.term.rows })
}

export function disposeTerm(id: string): void {
  const e = entries.get(id)
  if (!e) return
  window.api.pty.kill(id)
  clearTimeout(e.resizeTimer)
  e.webgl?.dispose()
  e.term.dispose()
  e.el.remove()
  entries.delete(id)
}

/** Plain-text dump of a terminal's visible screen (debugging / scripted checks). */
export function readScreen(id: string): string {
  const e = entries.get(id)
  if (!e) return ''
  const b = e.term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < e.term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  return lines.join('\n').replace(/\n+$/, '')
}
