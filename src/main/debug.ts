import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'fs'

/**
 * Dev-only automation: STUDIO_DEBUG_SCRIPT=<steps.json> runs a list of
 * { wait?: ms, js?: string, shot?: "out.png", quit?: true } against the renderer.
 */
export function runDebugScript(win: BrowserWindow): void {
  const file = process.env.STUDIO_DEBUG_SCRIPT
  if (!file) return
  const steps: { wait?: number; js?: string; shot?: string; quit?: boolean; type?: string }[] = JSON.parse(readFileSync(file, 'utf8'))
  win.webContents.once('did-finish-load', async () => {
    for (const s of steps) {
      try {
        if (s.js) {
          const v = await win.webContents.executeJavaScript(s.js)
          if (v !== undefined) console.log('[debug js]', typeof v === 'string' ? v : JSON.stringify(v))
        }
        if (s.type) {
          // real keystrokes, as if typed on the keyboard
          for (const ch of s.type) {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
            win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
          }
        }
        if (s.wait) await new Promise((r) => setTimeout(r, s.wait))
        if (s.shot) {
          // force a fresh frame — an unfocused window can hand back a stale one
          win.webContents.invalidate()
          await new Promise((r) => setTimeout(r, 400))
          writeFileSync(s.shot, (await win.webContents.capturePage()).toPNG())
        }
      } catch (e) {
        console.error('[debug step failed]', e)
      }
      if (s.quit) app.quit()
    }
  })
}
