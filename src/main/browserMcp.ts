import { app, webContents, type BrowserWindow, type WebContents } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { callDbTool, DB_INSTRUCTIONS, DB_TOOLS } from './mssql'

/**
 * Built-in browser as an MCP server (like Claude desktop's preview tools).
 *
 * Every `claude` chat is launched with `--mcp-config <file>` pointing at
 * http://127.0.0.1:<port>/mcp/<chatId>, so each chat drives only its own Web tab.
 * Streamable HTTP transport, plain JSON replies (no SSE), guarded by a per-launch bearer token.
 */

const SERVER_NAME = 'vibe-browser'
/** SQL Server tools: same HTTP server, own MCP server entry (/db/<chatId>) */
const DB_SERVER_NAME = 'vibe-mssql'
const token = randomBytes(24).toString('hex')
let port = 0
let getWin: () => BrowserWindow | null = () => null

/** chatId → webContents id of that chat's <webview> (registered by the renderer on dom-ready) */
const views = new Map<string, number>()
const waiters = new Map<string, ((wc: WebContents) => void)[]>()

export function attachView(chatId: string, wcId: number): void {
  views.set(chatId, wcId)
  const wc = webContents.fromId(wcId)
  if (!wc) return
  for (const resolve of waiters.get(chatId) ?? []) resolve(wc)
  waiters.delete(chatId)
}

/** The chat's webview; asks the window to open (and show) the Web tab, waiting for it when needed. */
function viewFor(chatId: string): Promise<WebContents> {
  getWin()?.webContents.send('browser:open', chatId)
  const id = views.get(chatId)
  const wc = id === undefined ? undefined : webContents.fromId(id)
  if (wc && !wc.isDestroyed()) return Promise.resolve(wc)
  return new Promise((resolve, reject) => {
    const list = waiters.get(chatId) ?? []
    list.push(resolve)
    waiters.set(chatId, list)
    setTimeout(() => reject(new Error("This chat's Web tab did not open within 15s. Ask the user to open this chat (or its Web tab) and try again.")), 15000)
  })
}

/** `--mcp-config` file for one chat (rewritten each launch: the port and token change). */
export function mcpConfigFor(chatId: string): string | null {
  if (!port) return null
  const dir = join(app.getPath('userData'), 'mcp')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, chatId.replace(/[^\w-]/g, '_') + '.json')
  const config = {
    mcpServers: {
      [SERVER_NAME]: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(chatId)}`,
        headers: { Authorization: `Bearer ${token}` }
      },
      [DB_SERVER_NAME]: {
        type: 'http',
        url: `http://127.0.0.1:${port}/db/${encodeURIComponent(chatId)}`,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  }
  writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

/* ---------------- page scripts (run inside the web page) ---------------- */

/** Numbers every visible interactive element (data-vibe-ref) and returns them with the page text. */
const SNAPSHOT_JS = `(() => {
  const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable=true],[onclick]'
  document.querySelectorAll('[data-vibe-ref]').forEach((e) => e.removeAttribute('data-vibe-ref'))
  const elements = []
  let n = 0
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    el.setAttribute('data-vibe-ref', String(++n))
    const tag = el.tagName.toLowerCase()
    const kind = el.getAttribute('role') || (tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag)
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 80)
    let line = '[' + n + '] ' + kind + ' "' + label + '"'
    if (tag === 'a') line += ' -> ' + (el.getAttribute('href') || '').slice(0, 120)
    if (el.disabled) line += ' (disabled)'
    if (el.checked) line += ' (checked)'
    elements.push(line)
    if (n >= 400) break
  }
  const text = document.body ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000) : ''
  return { title: document.title, url: location.href, elements, text }
})()`

/** JS expression for the element a tool call points at: { ref } from the last snapshot, or { selector }. */
function findJs(args: Record<string, unknown>): string {
  if (args.ref !== undefined) return `document.querySelector('[data-vibe-ref="' + ${JSON.stringify(String(args.ref))} + '"]')`
  if (typeof args.selector === 'string') return `document.querySelector(${JSON.stringify(args.selector)})`
  throw new Error('Pass `ref` (from browser_snapshot) or `selector`.')
}

const clickJs = (find: string): string => `(() => {
  const el = ${find}
  if (!el) return 'Element not found. Take a new browser_snapshot: refs change when the page changes.'
  el.scrollIntoView({ block: 'center', inline: 'center' })
  if (el.focus) el.focus()
  const o = { bubbles: true, cancelable: true, view: window }
  el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o))
  el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o))
  el.click()
  return 'ok'
})()`

/** Replaces the field's value in a way React/Vue inputs notice (native setter + input/change events). */
const typeJs = (find: string, text: string): string => `(() => {
  const el = ${find}
  if (!el) return 'Element not found. Take a new browser_snapshot: refs change when the page changes.'
  el.scrollIntoView({ block: 'center' })
  el.focus()
  const text = ${JSON.stringify(text)}
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (el instanceof HTMLSelectElement) {
    const opt = [...el.options].find((o) => o.value === text || o.text.trim() === text)
    if (!opt) return 'No option "' + text + '" in this select.'
    el.value = opt.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (el.isContentEditable) {
    document.execCommand('selectAll')
    document.execCommand('insertText', false, text)
  } else return 'That element is not a text field.'
  return 'ok'
})()`

/* ---------------- tools ---------------- */

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const target = {
  ref: { type: 'string', description: 'Element number from the last browser_snapshot, e.g. "12"' },
  selector: { type: 'string', description: 'CSS selector, used when no ref is given' }
}

const TOOLS = [
  {
    name: 'browser_navigate',
    description: "Open a URL in this chat's Web tab (the built-in browser the user sees). Waits for the page to load.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'browser_snapshot',
    description:
      'Read the current page: URL, title, visible text, and a numbered list of interactive elements. Use the numbers as `ref` for browser_click / browser_type. Take a new snapshot after the page changes.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_click',
    description: 'Click an element (by `ref` from browser_snapshot, or by CSS `selector`).',
    inputSchema: { type: 'object', properties: target }
  },
  {
    name: 'browser_type',
    description: 'Set the text of an input, textarea, contenteditable or select (option value or label). `submit` presses Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: { ...target, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['text']
    }
  },
  {
    name: 'browser_press_key',
    description: 'Press a key in the page, e.g. "Enter", "Escape", "Tab", "Down", "PageDown", "a".',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
  },
  {
    name: 'browser_screenshot',
    description: 'Screenshot of the Web tab as the user sees it.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_eval',
    description: 'Run a JavaScript expression in the page and return its (JSON) result. Promises are awaited.',
    inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }
  }
]

const text = (t: string): Content[] => [{ type: 'text', text: t }]

async function pressKey(wc: WebContents, key: string): Promise<void> {
  wc.focus()
  wc.sendInputEvent({ type: 'keyDown', keyCode: key })
  // Enter and single characters also need a `char` event — that is what types text / submits forms
  if (key.toLowerCase() === 'enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
  else if (key.length === 1) wc.sendInputEvent({ type: 'char', keyCode: key })
  wc.sendInputEvent({ type: 'keyUp', keyCode: key })
}

async function callTool(chatId: string, name: string, args: Record<string, unknown>): Promise<Content[]> {
  const wc = await viewFor(chatId)
  switch (name) {
    case 'browser_navigate': {
      const url = String(args.url ?? '')
      if (!/^(https?|file):/i.test(url)) throw new Error('Only http(s) and file URLs.')
      await wc.loadURL(url)
      return text(`Loaded ${wc.getURL()} — "${wc.getTitle()}"`)
    }
    case 'browser_snapshot': {
      const s = (await wc.executeJavaScript(SNAPSHOT_JS)) as { title: string; url: string; elements: string[]; text: string }
      return text(`URL: ${s.url}\nTitle: ${s.title}\n\nInteractive elements:\n${s.elements.join('\n') || '(none)'}\n\nPage text:\n${s.text}`)
    }
    case 'browser_click':
      return text(String(await wc.executeJavaScript(clickJs(findJs(args)))))
    case 'browser_type': {
      const r = String(await wc.executeJavaScript(typeJs(findJs(args), String(args.text ?? ''))))
      if (r === 'ok' && args.submit) await pressKey(wc, 'Enter')
      return text(r)
    }
    case 'browser_press_key':
      await pressKey(wc, String(args.key ?? ''))
      return text('ok')
    case 'browser_screenshot': {
      const img = await wc.capturePage()
      if (img.isEmpty()) return text('The Web tab is hidden (another chat or the Source code tab is in front), so there is nothing to capture.')
      return [{ type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }]
    }
    case 'browser_eval': {
      const v = await wc.executeJavaScript(String(args.expression ?? ''), true)
      return text(v === undefined ? 'undefined' : JSON.stringify(v, null, 2) ?? String(v))
    }
  }
  throw new Error(`Unknown tool ${name}`)
}

/* ---------------- MCP over HTTP (JSON-RPC) ---------------- */

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

async function handleRpc(chatId: string, msg: RpcRequest, dbTools: boolean): Promise<unknown> {
  if (dbTools) {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: DB_SERVER_NAME, version: '0.1.0' },
          instructions: DB_INSTRUCTIONS
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: DB_TOOLS }
      case 'tools/call':
        try {
          return { content: text(await callDbTool(String(msg.params?.name), (msg.params?.arguments ?? {}) as Record<string, unknown>)) }
        } catch (e) {
          return { content: text(e instanceof Error ? e.message : String(e)), isError: true }
        }
    }
    throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 })
  }
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        instructions: "These tools drive the Web tab of this chat in VIBE CODE — the browser the user is looking at. Use them when the user refers to 'the browser', 'the web page' or 'tab Web'."
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const name = String(msg.params?.name)
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      try {
        return { content: await callTool(chatId, name, args) }
      } catch (e) {
        return { content: text(e instanceof Error ? e.message : String(e)), isError: true }
      }
    }
  }
  throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const m = /^\/(mcp|db)\/([^/?]+)/.exec(req.url ?? '')
  if (!m || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(m ? 401 : 404).end()
    return
  }
  // no server-initiated stream (GET) and no session to end (DELETE)
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end()
    return
  }
  const chatId = decodeURIComponent(m[2])
  let msg: RpcRequest
  try {
    msg = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }
  // notifications (no id) get no reply
  if (msg.id === undefined) {
    res.writeHead(202).end()
    return
  }
  let reply: unknown
  try {
    reply = { jsonrpc: '2.0', id: msg.id, result: await handleRpc(chatId, msg, m[1] === 'db') }
  } catch (e) {
    const code = (e as { code?: number }).code ?? -32603
    reply = { jsonrpc: '2.0', id: msg.id, error: { code, message: e instanceof Error ? e.message : String(e) } }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(reply))
}

/** Starts the server on a free localhost port; resolves once chats can be given a config. */
export function startBrowserMcp(win: () => BrowserWindow | null): Promise<void> {
  getWin = win
  const server = createServer((req, res) => {
    onRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') port = addr.port
      resolve()
    })
  })
}
