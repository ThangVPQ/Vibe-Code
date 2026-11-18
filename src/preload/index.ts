import { contextBridge, ipcRenderer, type IpcRendererEvent, webUtils } from 'electron'
import type { AppSettings, ClaudeInfo, DirEntry, GitCommit, GitCommitFile, GitState, ProjectGroup, PtySpawnOptions, UsageLimit, WindowMode, WindowState } from '../shared/types'

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
    usage: (): Promise<UsageLimit[] | null> => ipcRenderer.invoke('claude:usage'),
    getProjectBypass:(folder: string): Promise<boolean> => ipcRenderer.invoke('claude:getProjectBypass', folder),
    setProjectBypass: (folder: string, on: boolean): Promise<boolean> => ipcRenderer.invoke('claude:setProjectBypass', folder, on)
  },
  browser: {
    /** a chat's <webview> is ready: its browser tools can now drive it */
    attach: (chatId: string, webContentsId: number): void => ipcRenderer.send('browser:attach', chatId, webContentsId),
    /** a chat's browser tools were used: make sure its Web tab exists (and show it) */
    onOpen: (cb: (chatId: string) => void) => on('browser:open', cb)
  },
  sessions: {
    list: (): Promise<ProjectGroup[]> => ipcRenderer.invoke('sessions:list'),
    /** images in a chat's conversation, as data: URLs, oldest first */
    images: (sessionId: string): Promise<string[]> => ipcRenderer.invoke('sessions:images', sessionId),
    /** tokens in the chat's context window right now (last API call), or null before the first reply */
    context: (sessionId: string): Promise<{ used: number; model: string } | null> => ipcRenderer.invoke('sessions:context', sessionId),
    onChanged: (cb: () => void) => on('sessions:changed', cb)
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
