import { contextBridge, ipcRenderer, type IpcRendererEvent, webUtils } from 'electron'
import type { AgentInfo, ChatTask, AppSettings, ClaudeInfo, DbColumn, DbConnection, DbConnectionInput, DbFound, DbObject, DbQueryResult, DirEntry, GitCommit, GitCommitFile, GitState, ProjectGroup, PtySpawnOptions, UsageLimit, WindowMode, WindowState, ZaloMessage, ZaloState, ZaloSticker, ZaloThread, WebData, WebSuggestion, ZaloThreadInfo, ZaloTyping, ZaloTask, ZaloTasksState } from '../shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  platform: process.platform,
  pty: {
    spawn: (o: PtySpawnOptions): Promise<void> => ipcRenderer.invoke('pty:spawn', o),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    onData: (cb: (id: string, data: string) => void) => on('pty:data', cb),
    onExit: (cb: (id: string, code: number) => void) => on('pty:exit', cb)
  },
  claude: {
    detect: (): Promise<ClaudeInfo> => ipcRenderer.invoke('claude:detect'),
    agents: (): Promise<AgentInfo[]> => ipcRenderer.invoke('agents:detect'),
    usage: (): Promise<UsageLimit[] | null> => ipcRenderer.invoke('claude:usage'),
    getProjectBypass:(folder: string): Promise<boolean> => ipcRenderer.invoke('claude:getProjectBypass', folder),
    setProjectBypass: (folder: string, on: boolean): Promise<boolean> => ipcRenderer.invoke('claude:setProjectBypass', folder, on)
  },
  browser: {
    /** a chat's <webview> is ready: its browser tools can now drive it */
    attach: (chatId: string, webContentsId: number): void => ipcRenderer.send('browser:attach', chatId, webContentsId),
    /** a chat's browser tools were used: make sure its Web tab exists (and show it) */
    onOpen: (cb: (chatId: string) => void) => on('browser:open', cb),
    /** bookmarks (and whether Chrome was imported yet), shared by every Web tab */
    data: (): Promise<WebData> => ipcRenderer.invoke('web:data'),
    /** one time: bookmarks + history of all Chrome profiles */
    importChrome: (): Promise<WebData> => ipcRenderer.invoke('web:importChrome'),
    suggest: (query: string): Promise<WebSuggestion[]> => ipcRenderer.invoke('web:suggest', query),
    visit: (url: string, title?: string): void => ipcRenderer.send('web:visit', url, title),
    title: (url: string, title: string): void => ipcRenderer.send('web:title', url, title)
  },
  sessions: {
    list: (): Promise<ProjectGroup[]> => ipcRenderer.invoke('sessions:list'),
    /** images in a chat's conversation, as data: URLs, oldest first */
    images: (sessionId: string): Promise<string[]> => ipcRenderer.invoke('sessions:images', sessionId),
    /** tokens in the chat's context window right now (last API call), or null before the first reply */
    context: (sessionId: string): Promise<{ used: number; model: string } | null> => ipcRenderer.invoke('sessions:context', sessionId),
    /** background tasks Claude started in this chat, newest first */
    tasks: (sessionId: string): Promise<ChatTask[]> => ipcRenderer.invoke('sessions:tasks', sessionId),
    onChanged: (cb: () => void) => on('sessions:changed', cb)
  },
  db: {
    list: (): Promise<DbConnection[]> => ipcRenderer.invoke('db:list'),
    /** one connection with its connection string (for editing) */
    get: (id: string): Promise<(DbConnection & { conn: string }) | null> => ipcRenderer.invoke('db:get', id),
    save: (c: DbConnectionInput): Promise<DbConnection[]> => ipcRenderer.invoke('db:save', c),
    saveMany: (list: DbConnectionInput[]): Promise<DbConnection[]> => ipcRenderer.invoke('db:saveMany', list),
    remove: (id: string): Promise<DbConnection[]> => ipcRenderer.invoke('db:remove', id),
    test: (conn: string): Promise<{ ok: boolean; error?: string; version?: string }> => ipcRenderer.invoke('db:test', conn),
    buildConn: (f: { server: string; database?: string; windowsAuth: boolean; user?: string; password?: string; trustCert?: boolean; encrypt?: boolean }): Promise<string> =>
      ipcRenderer.invoke('db:buildConn', f),
    /** key/value pairs of a connection string, keys lower-cased */
    parseConn: (conn: string): Promise<Record<string, string>> => ipcRenderer.invoke('db:parseConn', conn),
    query: (id: string, sql: string, database?: string, maxRows?: number): Promise<DbQueryResult> =>
      ipcRenderer.invoke('db:query', id, sql, database, maxRows),
    cancel: (): void => ipcRenderer.send('db:cancel'),
    databases: (id: string): Promise<string[]> => ipcRenderer.invoke('db:databases', id),
    objects: (id: string, database: string): Promise<DbObject[]> => ipcRenderer.invoke('db:objects', id, database),
    columns: (id: string, database: string, schema: string, table: string): Promise<DbColumn[]> =>
      ipcRenderer.invoke('db:columns', id, database, schema, table),
    scanProject: (folder: string): Promise<DbFound[]> => ipcRenderer.invoke('db:scanProject', folder),
    scanSsms: (): Promise<DbFound[]> => ipcRenderer.invoke('db:scanSsms')
  },
  zalo: {
    state: (): Promise<ZaloState> => ipcRenderer.invoke('zalo:state'),
    login: (): Promise<void> => ipcRenderer.invoke('zalo:login'),
    cancel: (): Promise<void> => ipcRenderer.invoke('zalo:cancel'),
    reconnect: (): Promise<ZaloState> => ipcRenderer.invoke('zalo:reconnect'),
    logout: (): Promise<void> => ipcRenderer.invoke('zalo:logout'),
    threads: (query?: string): Promise<ZaloThread[]> => ipcRenderer.invoke('zalo:threads', query),
    messages: (threadId: string, limit?: number, before?: number): Promise<ZaloMessage[]> => ipcRenderer.invoke('zalo:messages', threadId, limit, before),
    /** groups: fetch older messages from Zalo; returns how many arrived */
    syncAll: (): Promise<number> => ipcRenderer.invoke('zalo:syncAll'),
    loadOlder: (threadId: string): Promise<number> => ipcRenderer.invoke('zalo:loadOlder', threadId),
    send: (threadId: string, text: string, replyTo?: string): Promise<string> => ipcRenderer.invoke('zalo:send', threadId, text, replyTo),
    /** conversations for the tab: pinned first, then newest */
    uiThreads: (): Promise<ZaloThread[]> => ipcRenderer.invoke('zalo:uiThreads'),
    contacts: (): Promise<ZaloThread[]> => ipcRenderer.invoke('zalo:contacts'),
    /** the conversation on screen (its messages are marked read) */
    setActive: (threadId: string | null): Promise<void> => ipcRenderer.invoke('zalo:setActive', threadId),
    info: (threadId: string): Promise<ZaloThreadInfo> => ipcRenderer.invoke('zalo:info', threadId),
    sendFiles: (threadId: string, paths: string[], caption?: string): Promise<void> => ipcRenderer.invoke('zalo:sendFiles', threadId, paths, caption),
    sendSticker: (threadId: string, s: ZaloSticker): Promise<void> => ipcRenderer.invoke('zalo:sendSticker', threadId, s),
    stickers: (keyword: string): Promise<ZaloSticker[]> => ipcRenderer.invoke('zalo:stickers', keyword),
    react: (threadId: string, msgId: string, icon: string): Promise<void> => ipcRenderer.invoke('zalo:react', threadId, msgId, icon),
    recall: (threadId: string, msgId: string): Promise<void> => ipcRenderer.invoke('zalo:recall', threadId, msgId),
    deleteForMe: (threadId: string, msgId: string): Promise<void> => ipcRenderer.invoke('zalo:deleteForMe', threadId, msgId),
    forward: (fromThread: string, msgId: string, toThread: string): Promise<void> => ipcRenderer.invoke('zalo:forward', fromThread, msgId, toThread),
    typing: (threadId: string): void => ipcRenderer.send('zalo:typing', threadId),
    tasks: (): Promise<ZaloTasksState> => ipcRenderer.invoke('zalo:tasks'),
    analyzeTasks: (): Promise<ZaloTasksState> => ipcRenderer.invoke('zalo:tasksAnalyze'),
    setTaskStatus: (id: string, status: ZaloTask['status']): Promise<ZaloTasksState> => ipcRenderer.invoke('zalo:taskStatus', id, status),
    removeTask: (id: string): Promise<ZaloTasksState> => ipcRenderer.invoke('zalo:taskRemove', id),
    onTasks: (cb: (s: ZaloTasksState) => void) => on('zalo:tasks', cb),
    /** a "new task" notification was clicked */
    onShowTasks: (cb: () => void) => on('zalo:showTasks', cb),
    onState: (cb: (s: ZaloState) => void) => on('zalo:state', cb),
    /** ids of the conversations that changed ([] = reload everything) */
    onChanged: (cb: (ids: string[]) => void) => on('zalo:changed', cb),
    onTyping: (cb: (t: ZaloTyping) => void) => on('zalo:typing', cb)
  },
  win: {
    state: (): Promise<WindowState> => ipcRenderer.invoke('win:state'),
    minimize: (): void => ipcRenderer.send('win:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('win:toggleMaximize'),
    close: (): void => ipcRenderer.send('win:close'),
    hide: (): void => ipcRenderer.send('win:hide'),
    setMode: (m: WindowMode): void => ipcRenderer.send('win:setMode', m),
    onState: (cb: (s: WindowState) => void) => on('win:state', cb),
    onShown: (cb: () => void) => on('win:shown', cb)
  },
  fs: {
    readDir: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:readDir', dir),
    readFile: (p: string): Promise<{ content: string; binary: boolean; tooLarge: boolean }> =>
      ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p: string, c: string): Promise<void> => ipcRenderer.invoke('fs:writeFile', p, c),
    listFiles: (root: string): Promise<string[]> => ipcRenderer.invoke('fs:listFiles', root),
    watch: (root: string | null): Promise<void> => ipcRenderer.invoke('fs:watch', root),
    reveal: (p: string): Promise<void> => ipcRenderer.invoke('fs:reveal', p),
    /** open a folder (or file) with the OS default handler — a folder opens in Explorer */
    openPath: (p: string): Promise<string> => ipcRenderer.invoke('fs:openPath', p),
    onChanged: (cb: (paths: string[]) => void) => on('fs:changed', cb)
  },
  git: {
    state: (folder: string): Promise<GitState> => ipcRenderer.invoke('git:state', folder),
    original: (root: string, rel: string): Promise<string> => ipcRenderer.invoke('git:original', root, rel),
    init: (folder: string): Promise<void> => ipcRenderer.invoke('git:init', folder),
    show: (root: string, rev: string, rel: string): Promise<string> => ipcRenderer.invoke('git:show', root, rev, rel),
    log: (root: string): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', root),
    commitFiles: (root: string, hash: string): Promise<GitCommitFile[]> => ipcRenderer.invoke('git:commitFiles', root, hash)
  },
  app: {
    settings: (): Promise<AppSettings> => ipcRenderer.invoke('app:settings'),
    rememberFolder: (f: string): Promise<AppSettings> => ipcRenderer.invoke('app:rememberFolder', f),
    setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('app:setSettings', patch),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('app:pickFolder'),
    /** OS file picker (multi-select); [] when cancelled */
    pickFiles: (defaultPath?: string): Promise<string[]> => ipcRenderer.invoke('app:pickFiles', defaultPath),
    /** size, folder?, and an image's data: URL (≤15 MB) for each path */
    fileInfo: (paths: string[]): Promise<{ path: string; size: number; dir: boolean; preview?: string }[]> =>
      ipcRenderer.invoke('app:fileInfo', paths),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
    clearBrowserCache: (): Promise<void> => ipcRenderer.invoke('app:clearBrowserCache'),
    relaunch: (): Promise<boolean> => ipcRenderer.invoke('app:relaunch'),
    saveImage: (data: Uint8Array, ext: string): Promise<string> => ipcRenderer.invoke('app:saveImage', data, ext),
    /** disk path of a dropped File ('' for clipboard blobs) */
    pathFor: (file: File): string => webUtils.getPathForFile(file)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
