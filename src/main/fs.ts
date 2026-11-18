import { promises as fsp } from 'fs'
import { join, relative } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { WebContents } from 'electron'
import type { DirEntry } from '../shared/types'

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])
const SKIP_WALK = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'bin', 'obj', '.vs'])

export async function readDir(dir: string): Promise<DirEntry[]> {
  const items = await fsp.readdir(dir, { withFileTypes: true })
  return items
    .filter((d) => !HIDDEN.has(d.name))
    .map((d) => ({ name: d.name, path: join(dir, d.name), isDir: d.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1))
}

export async function readFile(path: string): Promise<{ content: string; binary: boolean; tooLarge: boolean }> {
  const stat = await fsp.stat(path)
  if (stat.size > 8 * 1024 * 1024) return { content: '', binary: false, tooLarge: true }
  const buf = await fsp.readFile(path)
  const probe = buf.subarray(0, 8000)
  if (probe.includes(0)) return { content: '', binary: true, tooLarge: false }
  return { content: buf.toString('utf8'), binary: false, tooLarge: false }
}

export async function writeFile(path: string, content: string): Promise<void> {
  await fsp.writeFile(path, content, 'utf8')
}

/** Flat list of files (relative paths) for quick-open. */
export async function listFiles(root: string, limit = 20000): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return
    let items
    try {
      items = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of items) {
      if (out.length >= limit) return
      if (d.isDirectory()) {
        if (!SKIP_WALK.has(d.name)) await walk(join(dir, d.name))
      } else {
        out.push(relative(root, join(dir, d.name)).replace(/\\/g, '/'))
      }
    }
  }
  await walk(root)
  return out
}

let watcher: FSWatcher | null = null
let pending = new Set<string>()
let timer: NodeJS.Timeout | null = null

export function watchFolder(wc: WebContents, root: string | null): void {
  watcher?.close()
  watcher = null
  if (!root) return
  watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (p: string) => /[\\/](node_modules|\.git[\\/]objects|out|dist)([\\/]|$)/.test(p),
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    depth: 12
  })
  watcher.on('all', (_evt, p) => {
    pending.add(p)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const paths = [...pending]
      pending = new Set()
      if (!wc.isDestroyed()) wc.send('fs:changed', paths)
    }, 200)
  })
}
