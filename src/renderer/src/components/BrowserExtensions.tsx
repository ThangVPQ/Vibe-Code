import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, Loader, Plus, Puzzle, Settings2, Trash2 } from 'lucide-react'
import type { WebExtension } from '../../../shared/types'
import { useT } from '../i18n'

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
  const t = useT()
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
        title={t('Extensions', 'Tiện ích')}
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
            <div className="sb-menu-title">{t('Extensions in the Web tabs', 'Tiện ích trong các tab Web')}</div>
            {list === null && <div className="ext-empty">{t('Loading…', 'Đang tải…')}</div>}
            {list?.map((x) => {
              const on = x.builtin ? adBlock : x.enabled
              return (
                <div key={x.id} className={`ext-row${on ? '' : ' off'}`}>
                  <Puzzle size={14} className="ext-icon" />
                  <span className="ext-name" title={x.id}>
                    {x.name}
                    {x.builtin && <span className="ext-tag">{t('built-in', 'tích hợp sẵn')}</span>}
                  </span>
                  {x.options && (
                    <button
                      className="icon-btn"
                      title={t('Settings (opens in a new tab)', 'Cài đặt (mở trong tab mới)')}
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
                      title={t('Remove', 'Xoá')}
                      disabled={!!busy}
                      onClick={async () => {
                        if (await window.api.ask(t(`Remove ${x.name} from the Web tabs?`, `Xoá ${x.name} khỏi các tab Web?`))) void run(x.id, () => window.api.browser.removeExtension(x.id))
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  <button
                    className={`more-switch${on ? ' on' : ''}`}
                    title={on ? t('On — click to turn off', 'Đang bật — bấm để tắt') : t('Off — click to turn on', 'Đang tắt — bấm để bật')}
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
              <input value={source} placeholder={t('Chrome Web Store link or extension id', 'Liên kết Chrome Web Store hoặc id tiện ích')} spellCheck={false} onChange={(e) => setSource(e.target.value)} />
              <button className="btn btn-primary btn-sm" disabled={!source.trim() || !!busy}>
                {busy === 'add' ? <Loader size={13} className="task-spin" /> : <Plus size={13} />} {t('Add', 'Thêm')}
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
              <FolderOpen size={13} /> {t('Add an unpacked folder…', 'Thêm thư mục chưa đóng gói…')}
            </button>
            {error && <div className="ext-error">{error}</div>}
            <div className="ext-note">{t('Extensions work inside the pages. There is no toolbar for their buttons, so use the settings icon to open their settings in a tab.', 'Tiện ích chạy bên trong trang. Không có thanh công cụ cho các nút của chúng, nên hãy dùng biểu tượng cài đặt để mở phần cài đặt của chúng trong một tab.')}</div>
          </div>,
          document.body
        )}
    </div>
  )
}
