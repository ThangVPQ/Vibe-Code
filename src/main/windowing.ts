import { app, globalShortcut, Menu, nativeImage, screen, Tray, type BrowserWindow, type Rectangle } from 'electron'
import { join } from 'path'
import { getSettings, updateSettings } from './settings'
import type { WindowMode, WindowState } from '../shared/types'

/**
 * Two ways to live on screen:
 *  - 'window'   : an ordinary desktop window
 *  - 'dropdown' : Guake-style — a global hotkey slides it down from the top edge of the
 *                 screen under the mouse, on top of every other app, and back up again.
 */

let win: BrowserWindow
let tray: Tray | null = null
let mode: WindowMode = 'window'
let normalBounds: Rectangle | null = null
let animating = false
let hotkeyOk = false
let quitting = false

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Whole-window opacity. In see-through mode the page fades its backgrounds instead, so the window stays solid. */
const winOpacity = (): number => (getSettings().seeThrough ? 1 : clamp(getSettings().dropOpacity, 0.2, 1))

export const iconPath = (name: string): string => join(__dirname, '../../resources', name)

export function windowState(): WindowState {
  return { mode, maximized: win?.isMaximized() ?? false, hotkey: getSettings().hotkey, hotkeyOk }
}

function pushState(): void {
  if (!win.isDestroyed()) win.webContents.send('win:state', windowState())
}

function targetDisplay(): Electron.Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

function dropBounds(): Rectangle {
  const wa = targetDisplay().workArea
  const h = Math.round(wa.height * clamp(getSettings().dropHeight, 0.25, 1))
  return { x: wa.x, y: wa.y, width: wa.width, height: h }
}

function animate(fromY: number, to: Rectangle, fromOp: number, toOp: number, ms: number, done: () => void): void {
  animating = true
  const start = Date.now()
  const step = (): void => {
    if (win.isDestroyed()) return
    const t = Math.min(1, (Date.now() - start) / ms)
    const e = 1 - Math.pow(1 - t, 3) // ease-out cubic
    win.setBounds({ ...to, y: Math.round(fromY + (to.y - fromY) * e) })
    win.setOpacity(fromOp + (toOp - fromOp) * e)
    if (t < 1) setTimeout(step, 7)
    else {
      animating = false
      done()
    }
  }
  step()
}

function slideDown(): void {
  const b = dropBounds()
  const op = winOpacity()
  win.setOpacity(0)
  win.setBounds({ ...b, y: b.y - b.height })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  animate(b.y - b.height, b, 0, op, 170, () => {
    win.focus()
    win.webContents.send('win:shown')
  })
}

function slideUp(): void {
  const b = win.getBounds()
  animate(b.y, { ...b, y: b.y - b.height }, win.getOpacity(), 0, 130, () => {
    win.hide()
    win.setBounds(b)
  })
}

/** Re-apply drop-down height/opacity after the settings changed (from the in-app panel or tray). */
export function applyDropPrefs(): void {
  if (mode === 'dropdown' && win.isVisible() && !animating) {
    win.setBounds(dropBounds())
    win.setOpacity(winOpacity())
  }
  // the opacity setting applies to the normal window too
  if (mode === 'window') win.setOpacity(winOpacity())
  buildTrayMenu()
  pushState()
}

export function toggleWindow(): void {
  if (animating) return
  if (mode === 'window') {
    if (win.isVisible() && win.isFocused() && !win.isMinimized()) win.minimize()
    else {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    return
  }
  if (win.isVisible()) {
    if (win.isFocused()) slideUp()
    else win.focus()
  } else slideDown()
}

export function hideDropdown(): void {
  if (mode === 'dropdown' && win.isVisible() && !animating) slideUp()
}

function applyDropdown(show: boolean): void {
  win.setSkipTaskbar(true)
  win.setMovable(false)
  win.setMaximizable(false)
  win.setMinimizable(false)
  win.setFullScreenable(false)
  win.setAlwaysOnTop(true, 'screen-saver')
  if (show) slideDown()
  else {
    win.setBounds(dropBounds())
    win.hide()
  }
}

function applyWindow(): void {
  win.setAlwaysOnTop(false)
  win.setSkipTaskbar(false)
  win.setMovable(true)
  win.setMaximizable(true)
  win.setMinimizable(true)
  win.setFullScreenable(true)
  win.setOpacity(winOpacity())
  if (normalBounds) win.setBounds(normalBounds)
  else {
    const wa = targetDisplay().workArea
    const w = Math.min(1480, wa.width - 80)
    const h = Math.min(920, wa.height - 60)
    win.setBounds({ x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + Math.round((wa.height - h) / 2), width: w, height: h })
  }
  win.show()
  win.focus()
}

export async function setMode(m: WindowMode): Promise<void> {
  if (m === mode) return
  if (m === 'dropdown') {
    if (win.isMaximized()) win.unmaximize()
    normalBounds = win.getBounds()
    mode = m
    applyDropdown(true)
  } else {
    mode = m
    applyWindow()
  }
  await updateSettings({ mode: m })
  pushState()
  buildTrayMenu()
}

/** F12 is reserved by Windows for the debugger, so we fall back through a few Guake-ish keys. */
const HOTKEY_FALLBACKS = ['Alt+`', 'Ctrl+Alt+`', 'Ctrl+Alt+Space']

function registerHotkey(): void {
  globalShortcut.unregisterAll()
  const wanted = getSettings().hotkey
  hotkeyOk = false
  for (const key of [wanted, ...HOTKEY_FALLBACKS.filter((k) => k !== wanted)]) {
    try {
      if (globalShortcut.register(key, toggleWindow)) {
        hotkeyOk = true
        if (key !== wanted) {
          console.warn(`[windowing] hotkey ${wanted} unavailable, using ${key}`)
          updateSettings({ hotkey: key })
        }
        return
      }
    } catch {
      /* invalid accelerator — try the next one */
    }
  }
  console.warn('[windowing] no global hotkey could be registered')
}

function buildTrayMenu(): void {
  if (!tray) return
  const s = getSettings()
  const heights = [0.4, 0.5, 0.6, 0.75, 0.9, 1]
  const opacities = [1, 0.9, 0.8, 0.6, 0.4, 0.25]
  tray.setToolTip(`VIBE CODE — ${hotkeyOk ? s.hotkey : 'no hotkey'} to show/hide`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show / Hide', accelerator: hotkeyOk ? s.hotkey : undefined, click: toggleWindow },
      { type: 'separator' },
      { label: 'Drop-down (Guake)', type: 'radio', checked: mode === 'dropdown', click: () => setMode('dropdown') },
      { label: 'Normal window', type: 'radio', checked: mode === 'window', click: () => setMode('window') },
      { type: 'separator' },
      {
        label: 'Drop-down height',
        submenu: heights.map((h) => ({
          label: `${Math.round(h * 100)}%`,
          type: 'radio' as const,
          checked: Math.abs(s.dropHeight - h) < 0.01,
          click: async () => {
            await updateSettings({ dropHeight: h })
            if (mode === 'dropdown' && win.isVisible()) win.setBounds(dropBounds())
            buildTrayMenu()
          }
        }))
      },
      {
        label: 'Window opacity',
        submenu: opacities.map((o) => ({
          label: `${Math.round(o * 100)}%`,
          type: 'radio' as const,
          checked: Math.abs(s.dropOpacity - o) < 0.005,
          click: async () => {
            await updateSettings({ dropOpacity: o })
            if (mode === 'window' || win.isVisible()) win.setOpacity(winOpacity())
            buildTrayMenu()
          }
        }))
      },
      {
        label: 'Hide when focus is lost',
        type: 'checkbox',
        checked: s.hideOnBlur,
        click: async (item) => {
          await updateSettings({ hideOnBlur: item.checked })
        }
      },
      { type: 'separator' },
      {
        label: 'Quit VIBE CODE',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

export function initWindowing(w: BrowserWindow): void {
  win = w
  const s = getSettings()

  tray = new Tray(nativeImage.createFromPath(iconPath('tray.png')).resize({ width: 16, height: 16 }))
  tray.on('click', toggleWindow)
  registerHotkey()
  buildTrayMenu()

  win.on('maximize', pushState)
  win.on('unmaximize', pushState)

  win.on('blur', () => {
    if (mode === 'dropdown' && getSettings().hideOnBlur && !animating && win.isVisible()) {
      // let a click on the tray icon (which also blurs) toggle instead of double-hiding
      setTimeout(() => !win.isFocused() && !animating && win.isVisible() && slideUp(), 120)
    }
  })

  // Dragging the bottom edge in drop-down mode changes the remembered height.
  win.on('resized', () => {
    if (mode !== 'dropdown' || animating) return
    const wa = targetDisplay().workArea
    const ratio = clamp(win.getBounds().height / wa.height, 0.25, 1)
    updateSettings({ dropHeight: Math.round(ratio * 100) / 100 }).then(() => {
      win.setBounds(dropBounds())
      buildTrayMenu()
    })
  })

  // In drop-down mode the close button just tucks the window away; the tray keeps us alive.
  win.on('close', (e) => {
    if (mode === 'dropdown' && !quitting) {
      e.preventDefault()
      hideDropdown()
    }
  })
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())

  if (s.mode === 'dropdown') {
    mode = 'dropdown'
    win.once('ready-to-show', () => applyDropdown(true))
  } else {
    win.once('ready-to-show', () => win.show())
  }
}
