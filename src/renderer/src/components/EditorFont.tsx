import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Minus, Plus, RotateCcw, Type } from 'lucide-react'
import { useStore } from '../store'
import type { AppSettings } from '../../../shared/types'

const DEFAULT_FONT = 'JetBrains Mono'
const DEFAULT_SIZE = 12
const MIN_SIZE = 9
const MAX_SIZE = 24

/** Monospace fonts worth offering; only the ones actually installed are shown (JetBrains Mono ships with the app). */
const CANDIDATES = [
  'JetBrains Mono',
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'Fira Code',
  'Fira Mono',
  'Source Code Pro',
  'Hack',
  'IBM Plex Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'Iosevka',
  'Victor Mono',
  'Monaspace Neon',
  'Geist Mono',
  'SF Mono',
  'Menlo',
  'DejaVu Sans Mono',
  'Lucida Console',
  'Courier New'
]

/** A font is installed if text in it measures differently from the generic fallbacks. */
function installed(font: string): boolean {
  if (font === DEFAULT_FONT) return true
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return true
  const sample = 'mmmmmmmmmmlli1WW@#0O'
  return ['monospace', 'serif', 'sans-serif'].some((base) => {
    ctx.font = `72px ${base}`
    const w0 = ctx.measureText(sample).width
    ctx.font = `72px "${font}", ${base}`
    return ctx.measureText(sample).width !== w0
  })
}

const stack = (font: string): string => `"${font}", "JetBrains Mono", Consolas, monospace`

/** The code editor's font options from settings (merge into Monaco's options). */
export function useEditorFont(): { fontFamily: string; fontSize: number; lineHeight: number; fontLigatures: boolean } {
  const font = useStore((s) => s.settings?.editorFont || DEFAULT_FONT)
  const size = useStore((s) => s.settings?.editorFontSize || DEFAULT_SIZE)
  const lig = useStore((s) => s.settings?.editorLigatures ?? true)
  // a font that was still loading measured wrong: re-measure once it's in
  useEffect(() => {
    document.fonts?.ready.then(() => import('../monaco')).then((m) => m.monaco.editor.remeasureFonts())
  }, [font])
  return useMemo(
    () => ({ fontFamily: stack(font), fontSize: size, lineHeight: Math.round(size * 1.5), fontLigatures: lig }),
    [font, size, lig]
  )
}

let saveSeq = 0
async function save(patch: Partial<AppSettings>): Promise<void> {
  // show it right away, then persist
  const my = ++saveSeq
  const cur = useStore.getState().settings
  if (cur) useStore.setState({ settings: { ...cur, ...patch } })
  const settings = await window.api.app.setSettings(patch).catch(() => null)
  // dragging the size slider sends many saves: an older answer must not undo a newer value
  if (settings && my === saveSeq) useStore.setState({ settings })
}

/** "Aa" button at the end of the editor tab bar: font family, size, ligatures. */
export function EditorFontButton(): React.JSX.Element {
  const font = useStore((s) => s.settings?.editorFont || DEFAULT_FONT)
  const size = useStore((s) => s.settings?.editorFontSize || DEFAULT_SIZE)
  const lig = useStore((s) => s.settings?.editorLigatures ?? true)
  const [open, setOpen] = useState(false)
  const [fonts, setFonts] = useState<string[]>([])
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setFonts(CANDIDATES.filter(installed))
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const setSize = (n: number): void => {
    save({ editorFontSize: Math.max(MIN_SIZE, Math.min(MAX_SIZE, n)) })
  }

  return (
    <div className="font-pick" ref={box}>
      <button className={`font-pick-btn${open ? ' on' : ''}`} title="Code font" onClick={() => setOpen(!open)}>
        <Type size={14} />
        <span>{size}</span>
      </button>
      {open && (
        <div className="font-pop">
          <div className="font-pop-head">Code font</div>
          <div className="font-size-row">
            <button className="font-size-btn" title="Smaller" disabled={size <= MIN_SIZE} onClick={() => setSize(size - 1)}>
              <Minus size={13} />
            </button>
            <input
              type="range"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={1}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
            <button className="font-size-btn" title="Larger" disabled={size >= MAX_SIZE} onClick={() => setSize(size + 1)}>
              <Plus size={13} />
            </button>
            <span className="font-size-val">{size}px</span>
          </div>
          <div className="font-list">
            {fonts.map((f) => (
              <button key={f} className={`font-item${f === font ? ' on' : ''}`} onClick={() => save({ editorFont: f })}>
                <span style={{ fontFamily: stack(f) }}>{f}</span>
                <span className="font-sample" style={{ fontFamily: stack(f) }}>
                  {'=> != 0O1lI'}
                </span>
                {f === font && <Check size={13} className="font-check" />}
              </button>
            ))}
          </div>
          <div className="font-pop-foot">
            <label className="font-lig">
              <input type="checkbox" checked={lig} onChange={(e) => save({ editorLigatures: e.target.checked })} />
              Ligatures (=&gt; ≠)
            </label>
            <button
              className="font-reset"
              title={`Back to ${DEFAULT_FONT} ${DEFAULT_SIZE}px`}
              onClick={() => save({ editorFont: DEFAULT_FONT, editorFontSize: DEFAULT_SIZE, editorLigatures: true })}
            >
              <RotateCcw size={12} /> Default
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
