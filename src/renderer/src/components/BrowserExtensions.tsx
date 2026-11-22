import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, Loader, Plus, Puzzle, Settings2, Trash2 } from 'lucide-react'
import type { WebExtension } from '../../../shared/types'

/**
 * The puzzle button of the Web tab: the extensions in the tabs (the ad blocker first, built in),
 * switched on / off or removed, and new ones added from the Chrome Web Store or a folder.
 */
export function ExtensionsButton(props: {
  adBlock: boolean
  onToggleAdBlock: () => void
  onOpen: (url: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const { adBlock, onToggleAdBlock, onOpen, onChanged } = props
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const [list, setList] = useState<WebExtension[] | null>(null)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const load = (): void => {
    window.api.browser
      .extensions()
      // WebView2's own (Microsoft Edge …, Microsoft Clipboard …) aren't the user's to manage
      .then((l) => setList(l.filter((x) => !x.name.startsWith('Microsoft '))))
      .catch((e) => {
        setList([])
        setError(String(e))
      })
  }
  useEffect(() => {
    if (!at) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setAt(null)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAt(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [at])

  /** a change: show it, then reload the page so it runs under the new set */
  const run = async (what: string, job: () => Promise<unknown>): Promise<void> => {
    setBusy(what)
    setError('')
    try {
      await job()
      onChanged()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
      load()
    }
  }
  const add = (from: string): Promise<void> =>
    run('add', async () => {
      await window.api.browser.addExtension(from)
      setSource('')
    })

  return (
    <div className="ext-wrap" ref={ref}>
      <button
        className={`icon-btn${at ? ' on' : ''}`}
        title="Extensions"
        onClick={(e) => {
          if (at) return setAt(null)
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ left: Math.max(8, Math.min(r.right - 340, window.innerWidth - 348)), top: r.bottom + 6 })
          setError('')
          load()
        }}
      >
        <Puzzle size={14} />
      </button>
      {at &&
        createPortal(
          <div className="ext-menu" ref={menu} style={at}>
            <div className="sb-menu-title">Extensions in the Web tabs</div>
            {list === null && <div className="ext-empty">Loading…</div>}
            {list?.map((x) => {
              const on = x.builtin ? adBlock : x.enabled
              return (
                <div key={x.id} className={`ext-row${on ? '' : ' off'}`}>
                  <Puzzle size={14} className="ext-icon" />
                  <span className="ext-name" title={x.id}>
                    {x.name}
                    {x.builtin && <span className="ext-tag">built-in</span>}
                  </span>
                  {x.options && (
                    <button
                      className="icon-btn"
                      title="Settings (opens in a new tab)"
                      onClick={() => {
                        setAt(null)
                        onOpen(x.options!)
                      }}
                    >
                      <Settings2 size={13} />
                    </button>
                  )}
                  {!x.builtin && (
                    <button
                      className="icon-btn"
                      title="Remove"
                      disabled={!!busy}
                      onClick={async () => {
                        if (await window.api.ask(`Remove ${x.name} from the Web tabs?`)) void run(x.id, () => window.api.browser.removeExtension(x.id))
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  <button
                    className={`more-switch${on ? ' on' : ''}`}
                    title={on ? 'On — click to turn off' : 'Off — click to turn on'}
                    disabled={!!busy}
                    onClick={() => (x.builtin ? onToggleAdBlock() : void run(x.id, () => window.api.browser.enableExtension(x.id, !x.enabled)))}
                  />
                </div>
              )
            })}
            <form
              className="ext-add"
              onSubmit={(e) => {
                e.preventDefault()
                if (source.trim()) void add(source)
              }}
            >
              <input value={source} placeholder="Chrome Web Store link or extension id" spellCheck={false} onChange={(e) => setSource(e.target.value)} />
              <button className="btn btn-primary btn-sm" disabled={!source.trim() || !!busy}>
                {busy === 'add' ? <Loader size={13} className="task-spin" /> : <Plus size={13} />} Add
              </button>
            </form>
            <button
              className="ext-folder"
              disabled={!!busy}
              onClick={async () => {
                const dir = await window.api.app.pickFolder()
                if (dir) void add(dir)
              }}
            >
              <FolderOpen size={13} /> Add an unpacked folder…
            </button>
            {error && <div className="ext-error">{error}</div>}
            <div className="ext-note">Extensions work inside the pages. There is no toolbar for their buttons, so use the settings icon to open their settings in a tab.</div>
          </div>,
          document.body
        )}
    </div>
  )
}
