import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { join } from 'path'
import { mkdir, readFile as readFileFs, stat as statFs, writeFile as writeFileFs } from 'fs/promises'

// Renamed from "TINJS Studio" to "VIBE CODE": keep using the old data folder so settings,
// recent folders and browser logins carry over.
// STUDIO_USER_DATA: a separate profile (and single-instance lock), so a dev copy can run beside the installed app.
app.setPath('userData', process.env.STUDIO_USER_DATA || join(app.getPath('appData'), 'TINJS Studio'))

/**
 * Same numbers as Claude Code's /usage: Anthropic's usage endpoint with the OAuth login that
 * `claude` keeps in ~/.claude/.credentials.json. Read-only; we never refresh the token ourselves
 * (Claude Code does, and two refreshers would fight) — an expired token just means null until it has.
 */
async function fetchUsage(): Promise<UsageLimit[] | null> {
  try {
    const raw = await readFileFs(join(app.getPath('home'), '.claude', '.credentials.json'), 'utf8')
    const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken
    if (!token) return null
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10000)
    })
    if (!r.ok) return null
    type Limit = { kind: string; percent: number; severity: string; resets_at: string | null; scope?: { model?: { display_name?: string } } | null }
    const j = (await r.json()) as { limits?: Limit[] }
    return (j.limits ?? []).map((l) => ({
      kind: l.kind,
      label: l.kind === 'session' ? '5-hour' : l.kind === 'weekly_all' ? 'Weekly' : `Weekly · ${l.scope?.model?.display_name ?? 'model'}`,
      percent: Math.round(l.percent),
      severity: l.severity,
      resetsAt: l.resets_at
    }))
  } catch {
    return null
  }
}

type ProjectLocal ={ permissions?: { defaultMode?: string; [k: string]: unknown }; [k: string]: unknown }

/** <project>/.claude/settings.local.json — {} when missing; throws when present but not valid JSON. */
async function readProjectLocal(folder: string): Promise<ProjectLocal> {
  let raw: string
  try {
    raw = await readFileFs(join(folder, '.claude', 'settings.local.json'), 'utf8')
  } catch {
    return {}
  }
  return raw.trim() ? (JSON.parse(raw) as ProjectLocal) : {}
}
import { detectAgents, detectClaude, killAll, killPty, resizePty, spawnPty, writePty } from './pty'
import { listFiles, readDir, readFile, watchFolder, writeFile } from './fs'
import { gitCommitFiles, gitInit, gitLog, gitOriginal, gitShow, gitState } from './git'
import { getSettings, rememberFolder, updateSettings } from './settings'
import { runDebugScript } from './debug'
import { applyDropPrefs, hideDropdown, iconPath, initWindowing, setMode, toggleWindow, windowState } from './windowing'
import { listSessions, sessionImages, sessionContext, sessionTasks, watchSessions } from './sessions'
import { attachView, startBrowserMcp } from './browserMcp'
import * as db from './mssql'
import * as zalo from './zalo'
import * as zaloTasks from './zaloTasks'
import * as webData from './webData'
import type { AppSettings, DbConnectionInput, PtySpawnOptions, UsageLimit, WindowMode, ZaloSticker, ZaloTask } from '../shared/types'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 760,
    minHeight: 280,
    show: false,
    // see-through mode: a transparent window; the page paints its own translucent backgrounds
    transparent: getSettings().seeThrough,
    backgroundColor: getSettings().seeThrough ? '#00000000' : getSettings().theme === 'light' ? '#e8ecf5' : '#1c2338',
    // Frameless title area; we draw our own window controls so the drop-down mode can hide them.
    titleBarStyle: 'hidden',
    title: 'VIBE CODE',
    icon: iconPath('icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      // chats keep streaming while the window is in the background or tucked away
      backgroundThrottling: false,
      // the built-in browser tab is a <webview>
      webviewTag: true
    }
  })

  initWindowing(win)
  runDebugScript(win)
  // A renderer reload (Ctrl+R, dev HMR) forgets its terminals — don't leave their processes behind.
  win.webContents.on('did-start-loading', () => killAll())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  win.on('closed', () => {
    killAll()
    win = null
  })
}

app.on('web-contents-created', (_e, wc) => {
  // the browser tab: no node, no preload; popups open in the same tab
  wc.on('will-attach-webview', (_ev, prefs) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
  })
  if (wc.getType() === 'webview') {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) wc.loadURL(url)
      return { action: 'deny' }
    })
  }
})

function registerIpc(): void {
  // PTY
  ipcMain.handle('pty:spawn', (e, opts: PtySpawnOptions) => spawnPty(e.sender, opts))
  // Typing into a terminal whose process is gone: tell the window, so the chat shows as ended
  // (and restarts) instead of silently swallowing every key.
  ipcMain.on('pty:write', (e, id: string, data: string) => {
    const ok = writePty(id, data)
    if (process.env.STUDIO_DEBUG_SCRIPT) console.log('[pty] write', id, JSON.stringify(data.slice(0, 40)), ok)
    if (!ok && !e.sender.isDestroyed()) e.sender.send('pty:exit', id, -1)
  })
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => resizePty(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => killPty(id))
  ipcMain.handle('claude:detect', () => detectClaude())
  ipcMain.handle('agents:detect', () => detectAgents())
  // each chat's Web tab tells us its <webview>, so that chat's browser tools can reach it
  ipcMain.on('browser:attach', (_e, chatId: string, wcId: number) => attachView(chatId, wcId))
  // Web tab bookmarks + history, shared by every tab (imported once from Chrome)
  ipcMain.handle('web:data', () => webData.getWebData())
  ipcMain.handle('web:importChrome', () => webData.importChrome())
  ipcMain.handle('web:suggest', (_e, q: string) => webData.suggest(q))
  ipcMain.on('web:visit', (_e, url: string, title?: string) => webData.recordVisit(url, title))
  ipcMain.on('web:title', (_e, url: string, title: string) => webData.setVisitTitle(url, title))
  // SQL Server: saved connections, queries, finding existing connections (project files, SSMS)
  ipcMain.handle('db:list', () => db.listConnections())
  ipcMain.handle('db:get', (_e, id: string) => db.getConnection(id))
  ipcMain.handle('db:save', (_e, c: DbConnectionInput) => db.saveConnection(c))
  ipcMain.handle('db:saveMany', (_e, list: DbConnectionInput[]) => db.saveConnections(list))
  ipcMain.handle('db:remove', (_e, id: string) => db.removeConnection(id))
  ipcMain.handle('db:test', (_e, conn: string) => db.testConnection(conn))
  ipcMain.handle('db:buildConn', (_e, f: Parameters<typeof db.buildConn>[0]) => db.buildConn(f))
  ipcMain.handle('db:parseConn', (_e, conn: string) => db.parseConn(conn))
  ipcMain.handle('db:query', (_e, id: string, sql: string, database?: string, maxRows?: number) => db.query(id, sql, database, maxRows))
  ipcMain.on('db:cancel', () => db.cancelQueries())
  ipcMain.handle('db:databases', (_e, id: string) => db.listDatabases(id))
  ipcMain.handle('db:objects', (_e, id: string, database: string) => db.listObjects(id, database))
  ipcMain.handle('db:columns', (_e, id: string, database: string, schema: string, table: string) => db.listColumns(id, database, schema, table))
  ipcMain.handle('db:scanProject', (_e, folder: string) => db.scanProject(folder))
  ipcMain.handle('db:scanSsms', () => db.scanSsms())
  // Zalo (personal account via zca-js): QR login, synced conversations, sending
  ipcMain.handle('zalo:state', () => zalo.getState())
  ipcMain.handle('zalo:login', () => zalo.loginQR())
  ipcMain.handle('zalo:cancel', () => zalo.cancelLogin())
  ipcMain.handle('zalo:reconnect', () => zalo.reconnect())
  ipcMain.handle('zalo:logout', () => zalo.logout())
  ipcMain.handle('zalo:threads', (_e, q?: string) => zalo.listThreads(q))
  ipcMain.handle('zalo:messages', (_e, threadId: string, limit?: number, before?: number) => zalo.getMessages(threadId, limit, before))
  ipcMain.handle('zalo:syncAll', () => zalo.syncAll())
  ipcMain.handle('zalo:loadOlder', (_e, threadId: string) => zalo.loadOlder(threadId))
  ipcMain.handle('zalo:send', (_e, threadId: string, text: string, replyTo?: string) => zalo.sendText(threadId, text, undefined, replyTo))
  ipcMain.handle('zalo:uiThreads', () => zalo.uiThreads())
  ipcMain.handle('zalo:contacts', () => zalo.contacts())
  ipcMain.handle('zalo:setActive', (_e, threadId: string | null) => zalo.setActive(threadId))
  ipcMain.handle('zalo:info', (_e, threadId: string) => zalo.threadInfo(threadId))
  ipcMain.handle('zalo:sendFiles', (_e, threadId: string, paths: string[], caption?: string) => zalo.sendFiles(threadId, paths, caption))
  ipcMain.handle('zalo:sendSticker', (_e, threadId: string, s: ZaloSticker) => zalo.sendSticker(threadId, s))
  ipcMain.handle('zalo:stickers', (_e, keyword: string) => zalo.searchStickers(keyword))
  ipcMain.handle('zalo:react', (_e, threadId: string, msgId: string, icon: string) => zalo.react(threadId, msgId, icon))
  ipcMain.handle('zalo:recall', (_e, threadId: string, msgId: string) => zalo.recall(threadId, msgId))
  ipcMain.handle('zalo:deleteForMe', (_e, threadId: string, msgId: string) => zalo.deleteForMe(threadId, msgId))
  ipcMain.handle('zalo:forward', (_e, fromThread: string, msgId: string, toThread: string) => zalo.forward(fromThread, msgId, toThread))
  ipcMain.on('zalo:typing', (_e, threadId: string) => zalo.typing(threadId))
  ipcMain.handle('zalo:tasks', () => zaloTasks.getTasks())
  ipcMain.handle('zalo:tasksAnalyze', () => zaloTasks.analyze())
  ipcMain.handle('zalo:taskStatus', (_e, id: string, status: ZaloTask['status']) => zaloTasks.setStatus(id, status))
  ipcMain.handle('zalo:taskRemove', (_e, id: string) => zaloTasks.removeTask(id))
  ipcMain.on('zalo:tasksViewing', (_e, on: boolean) => zaloTasks.setViewing(on))

  // Claude session store (shared with the Claude desktop app / CLI)
  ipcMain.handle('sessions:list', (e) => {
    watchSessions(e.sender)
    return listSessions()
  })

  ipcMain.handle('sessions:images', (_e, sessionId: string) => sessionImages(sessionId))
  ipcMain.handle('sessions:context', (_e, sessionId: string) => sessionContext(sessionId))
  ipcMain.handle('sessions:tasks', (_e, sessionId: string) => sessionTasks(sessionId))

  // Files
  ipcMain.handle('fs:readDir', (_e, dir: string) => readDir(dir))
  ipcMain.handle('fs:readFile', (_e, p: string) => readFile(p))
  ipcMain.handle('fs:writeFile', (_e, p: string, c: string) => writeFile(p, c))
  ipcMain.handle('fs:listFiles', (_e, root: string) => listFiles(root))
  ipcMain.handle('fs:watch', (e, root: string | null) => watchFolder(e.sender, root))
  ipcMain.handle('fs:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('fs:openPath', (_e, p: string) => shell.openPath(p))

  // Git
  ipcMain.handle('git:state', (_e, folder: string) => gitState(folder))
  ipcMain.handle('git:original', (_e, root: string, rel: string) => gitOriginal(root, rel))
  ipcMain.handle('git:init', (_e, folder: string) => gitInit(folder))
  ipcMain.handle('git:show', (_e, root: string, rev: string, rel: string) => gitShow(root, rev, rel))
  ipcMain.handle('git:log', (_e, root: string) => gitLog(root))
  ipcMain.handle('git:commitFiles', (_e, root: string, hash: string) => gitCommitFiles(root, hash))

  // Window
  ipcMain.handle('win:state', () => windowState())
  ipcMain.on('win:minimize', () => win?.minimize())
  ipcMain.on('win:toggleMaximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  ipcMain.on('win:close', () => win?.close())
  ipcMain.on('win:hide', () => hideDropdown())
  ipcMain.on('win:setMode', (_e, m: WindowMode) => setMode(m))

  // App
  ipcMain.handle('app:settings', () => getSettings())
  ipcMain.handle('app:setSettings', async (_e, patch: Partial<AppSettings>) => {
    const allowed: (keyof AppSettings)[] = ['theme', 'dropOpacity', 'dropHeight', 'hideOnBlur', 'model', 'effort', 'permissionMode', 'seeThrough']
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k as keyof AppSettings)))
    const s = await updateSettings(clean)
    if ('dropOpacity' in clean || 'dropHeight' in clean || 'hideOnBlur' in clean) applyDropPrefs()
    return s
  })
  ipcMain.handle('app:rememberFolder', (_e, f: string) => rememberFolder(f))
  ipcMain.handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  // Chat "Attach files": Claude Code reads files by path, so we only hand back the chosen paths.
  ipcMain.handle('app:pickFiles', async (_e, defaultPath?: string): Promise<string[]> => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Attach files to the chat',
      defaultPath: defaultPath || undefined,
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })
  // Chat attachment tray: size + (for images) the picture itself as a data: URL for the thumbnail/lightbox.
  ipcMain.handle('app:fileInfo', async (_e, paths: string[]) => {
    const MIME: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif'
    }
    return Promise.all(
      paths.map(async (p) => {
        try {
          const st = await statFs(p)
          const mime = MIME[(p.split('.').pop() ?? '').toLowerCase()]
          let preview: string | undefined
          if (mime && st.isFile() && st.size <= 15 * 1024 * 1024) {
            preview = `data:${mime};base64,${(await readFileFs(p)).toString('base64')}`
          }
          return { path: p, size: st.isFile() ? st.size : -1, dir: st.isDirectory(), preview }
        } catch {
          return { path: p, size: -1, dir: false }
        }
      })
    )
  })
  // Under `electron-vite dev` a relaunched app would lose its dev server, so the user restarts by hand.
  ipcMain.handle('app:relaunch', (): boolean => {
    if (process.env.ELECTRON_RENDERER_URL) return false
    app.relaunch()
    app.exit(0)
    return true
  })
  // Pasted / dropped images: Claude Code reads image files by path, so park them in temp.
  // Per-project bypass: Claude Code's own setting `permissions.defaultMode` in <project>/.claude/settings.local.json
  ipcMain.handle('claude:getProjectBypass', async (_e, folder: string): Promise<boolean> => {
    const s = await readProjectLocal(folder).catch(() => null)
    return s?.permissions?.defaultMode === 'bypassPermissions'
  })
  ipcMain.handle('claude:setProjectBypass', async (_e, folder: string, on: boolean): Promise<boolean> => {
    const file = join(folder, '.claude', 'settings.local.json')
    // never overwrite a file we can't parse — that would wipe the user's settings
    const s = await readProjectLocal(folder)
    const permissions = { ...(s.permissions ?? {}) }
    if (on) permissions.defaultMode = 'bypassPermissions'
    else if (permissions.defaultMode === 'bypassPermissions') delete permissions.defaultMode
    const next = { ...s, permissions }
    if (!Object.keys(permissions).length) delete (next as { permissions?: unknown }).permissions
    await mkdir(join(folder, '.claude'), { recursive: true })
    await writeFileFs(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
    return on
  })
  // Plan usage limits (5-hour / weekly), read with the Claude Code login on this machine.
  ipcMain.handle('claude:usage', (): Promise<UsageLimit[] | null> => fetchUsage())
  ipcMain.handle('app:saveImage', async (_e, data: Uint8Array, ext: string): Promise<string> => {
    const dir = join(app.getPath('temp'), 'tinjs-paste')
    await mkdir(dir, { recursive: true })
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'png'
    const file = join(dir, `image-${Date.now()}.${safeExt}`)
    await writeFileFs(file, Buffer.from(data))
    return file
  })
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  // Web tab: drop cached files (HTTP cache, Cache Storage, service workers, code cache) but keep
  // cookies and localStorage, so logins survive.
  ipcMain.handle('app:clearBrowserCache', async () => {
    const ses = session.fromPartition('persist:tinjs-browser')
    await ses.clearCache()
    await ses.clearCodeCaches({})
    await ses.clearStorageData({ storages: ['cachestorage', 'serviceworkers', 'shadercache'] })
  })
}

// One instance only: launching it again just toggles the existing window (Guake-style).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => win && toggleWindow())

  app.whenReady().then(async () => {
    app.setAppUserModelId('vn.tinjs.studio')
    // before any chat starts: chats get the browser MCP server's address at launch
    await startBrowserMcp(() => win)
    registerIpc()
    createWindow()
    zalo.initZalo(() => win)
    zaloTasks.initZaloTasks(() => win)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    killAll()
    if (process.platform !== 'darwin') app.quit()
  })

  // Killing ConPTY sessions can stall on Windows; never linger as an invisible process
  // that holds the single-instance lock and swallows the next launch.
  app.on('before-quit', () => {
    killAll()
    db.cancelQueries()
    setTimeout(() => app.exit(0), 2500).unref()
  })
}
