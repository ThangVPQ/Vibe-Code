import { app } from 'electron'
import { promises as fsp, readFileSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../shared/types'

const file = (): string => join(app.getPath('userData'), 'settings.json')

const defaults: AppSettings = {
  recentFolders: [],
  lastFolder: null,
  mode: 'window',
  hotkey: 'Alt+`',
  dropHeight: 0.6,
  dropOpacity: 0.97,
  hideOnBlur: false,
  theme: 'system',
  model: '',
  effort: '',
  permissionMode: '',
  seeThrough: false
}

let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    cache = { ...defaults, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    cache = { ...defaults }
  }
  return cache!
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  cache = { ...getSettings(), ...patch }
  await fsp.writeFile(file(), JSON.stringify(cache, null, 2), 'utf8').catch(() => {})
  return cache
}

export async function rememberFolder(folder: string): Promise<AppSettings> {
  const s = getSettings()
  const recent = [folder, ...s.recentFolders.filter((f) => f.toLowerCase() !== folder.toLowerCase())].slice(0, 10)
  return updateSettings({ recentFolders: recent, lastFolder: folder })
}
