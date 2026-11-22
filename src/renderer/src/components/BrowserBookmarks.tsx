import { useEffect, useState } from 'react'
import { ChevronDown, Download, Folder, Globe } from 'lucide-react'
import type { WebBookmark, WebData } from '../../../shared/types'
import { useT } from '../i18n'

/* One copy for every Web tab: loaded once, and every bar updates after the import. */
let data: WebData | null = null
const subs = new Set<(d: WebData) => void>()
let loading: Promise<void> | null = null

function useWebData(): WebData | null {
  const [d, setD] = useState(data)
  useEffect(() => {
    subs.add(setD)
    if (!data && !loading)
      loading = window.api.browser.data().then(
        (x) => {
          data = x
          subs.forEach((f) => f(x))
        },
        () => {
          loading = null // let the next tab try again
        }
      )
    return () => void subs.delete(setD)
  }, [])
  return d
}

function host(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function Favicon({ url }: { url: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const h = host(url)
  if (!h || failed) return <Globe size={12} />
  return <img className="bm-icon" src={`https://www.google.com/s2/favicons?sz=32&domain=${h}`} alt="" onError={() => setFailed(true)} />
}

/** A folder's links, sub-folders flattened with their path. */
function flatten(list: WebBookmark[], path = ''): { b: WebBookmark; path: string }[] {
  return list.flatMap((b) => (b.children ? flatten(b.children, path ? `${path} / ${b.title}` : b.title) : [{ b, path }]))
}

export function BookmarkBar({ onOpen }: { onOpen: (url: string) => void }): React.JSX.Element | null {
  const t = useT()
  const d = useWebData()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  // the menu is fixed-positioned under its button: the bar scrolls sideways and would clip it
  const [at, setAt] = useState({ x: 0, y: 0 })
  if (!d) return null

  if (!d.importedAt) {
    if (!d.chromeFound) return null
    return (
      <div className="bm-bar bm-import">
        <span>{t('Bring your Chrome bookmarks and history into the Web tab (all profiles, one time).', 'Đưa dấu trang và lịch sử Chrome của bạn vào tab Web (mọi hồ sơ, một lần).')}</span>
        <button
          className="chip"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError('')
            try {
              data = await window.api.browser.importChrome()
              subs.forEach((f) => f(data!))
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          <Download size={12} />
          {busy ? t('Importing…', 'Đang nhập…') : t('Import from Chrome', 'Nhập từ Chrome')}
        </button>
        {error && <span className="bm-error">{error}</span>}
      </div>
    )
  }

  if (!d.bookmarks.length) return null
  return (
    <div className="bm-bar">
      {d.bookmarks.map((b, i) =>
        b.children ? (
          <div key={i} className="bm-folder">
            <button className={`bm-item${open === i ? ' on' : ''}`} title={b.title} onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setAt({ x: Math.min(r.left, window.innerWidth - 340), y: r.bottom + 2 })
                setOpen(open === i ? null : i)
              }}>
              <Folder size={12} />
              <span>{b.title}</span>
              <ChevronDown size={11} />
            </button>
            {open === i && (
              <>
                <div className="bm-scrim" onClick={() => setOpen(null)} />
                <div className="bm-menu" style={{ left: Math.max(4, at.x), top: at.y }}>
                  {flatten(b.children).map(({ b: x, path }, j) => (
                    <button
                      key={j}
                      title={x.url}
                      onClick={() => {
                        setOpen(null)
                        onOpen(x.url!)
                      }}
                    >
                      <Favicon url={x.url!} />
                      <span className="bm-menu-title">{x.title || x.url}</span>
                      {path && <span className="bm-menu-path">{path}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <button key={i} className="bm-item" title={`${b.title}\n${b.url}`} onClick={() => onOpen(b.url!)}>
            <Favicon url={b.url!} />
            {b.title && <span>{b.title}</span>}
          </button>
        )
      )}
    </div>
  )
}
