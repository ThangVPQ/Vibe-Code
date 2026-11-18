import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Laptop, Maximize, Monitor, RotateCw, Eraser, Smartphone, Tablet, X } from 'lucide-react'
import { useStore } from '../store'
import { HOME_URL, setBrowserUrl } from '../actions'
import { SlidePill } from './motion'

/** The parts of Electron's <webview> element this tab uses. */
interface WebviewEl extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  stop(): void
  getURL(): string
  loadURL(url: string): Promise<void>
  setZoomFactor(factor: number): void
  setUserAgent(ua: string): void
  getWebContentsId(): number
}

/** Typed text → URL: keep real URLs, add https:// to bare hosts, search everything else. */
function toUrl(input: string): string {
  const t = input.trim()
  if (/^(https?|file):\/\//i.test(t)) return t
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t)) return 'http://' + t
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t)) return 'https://' + t
  return 'https://www.google.com/search?q=' + encodeURIComponent(t)
}

/** The blank start page shows as an empty address bar. */
const display = (url: string): string => (url === HOME_URL ? '' : url)

/* ---------------- device emulation ---------------- */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const TABLET_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

interface Device {
  key: string
  label: string
  icon: JSX.Element
  w?: number
  h?: number
  /** phones/tablets also get a mobile browser identity, so sites serve their mobile layout */
  ua?: string
}

const DEVICES: Device[] = [
  { key: 'fit', label: 'Fit', icon: <Maximize size={13} /> },
  { key: 'fhd', label: 'Full HD 1920×1080', icon: <Monitor size={13} />, w: 1920, h: 1080 },
  { key: 'laptop', label: 'Laptop 1366×768', icon: <Laptop size={13} />, w: 1366, h: 768 },
  { key: 'ipad', label: 'iPad 820×1180', icon: <Tablet size={13} />, w: 820, h: 1180, ua: TABLET_UA },
  { key: 'mobile', label: 'Mobile 390×844', icon: <Smartphone size={13} />, w: 390, h: 844, ua: MOBILE_UA }
]

const DEVICE_KEY = 'vibe.browserDevice'
function savedDevice(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? 'fit'
  } catch {
    return 'fit'
  }
}

export function BrowserTab({ chatKey, tabId, active }: { chatKey: string; tabId: string; active: boolean }): JSX.Element {
  const ref = useRef<WebviewEl>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const url = useStore((s) => s.browsers[chatKey]?.tabs.find((t) => t.id === tabId)?.url ?? HOME_URL)
  // first URL only: later navigation happens inside the webview, not through `src`
  const [initial] = useState(url)
  const [address, setAddress] = useState(display(url))
  const shown = useRef(url)
  const [loading, setLoading] = useState(true)
  const [nav, setNav] = useState({ back: false, fwd: false })
  const [deviceKey, setDeviceKey] = useState(savedDevice)
  const device = DEVICES.find((d) => d.key === deviceKey) ?? DEVICES[0]
  const [initialUa] = useState(device.ua)
  const [ready, setReady] = useState(false)
  const [box, setBox] = useState<{ w: number; h: number; zoom: number } | null>(null)

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const sync = (): void => {
      const url = wv.getURL()
      setAddress(display(url))
      setNav({ back: wv.canGoBack(), fwd: wv.canGoForward() })
      shown.current = url
      setBrowserUrl(chatKey, url, tabId)
    }
    const onTitle = (e: Event): void => {
      const title = (e as Event & { title?: string }).title ?? ''
      setBrowserUrl(chatKey, wv.getURL(), tabId, title)
    }
    const start = (): void => setLoading(true)
    const stop = (): void => {
      setLoading(false)
      sync()
    }
    const onReady = (): void => setReady(true)
    wv.addEventListener('did-navigate', sync)
    wv.addEventListener('did-navigate-in-page', sync)
    wv.addEventListener('did-start-loading', start)
    wv.addEventListener('did-stop-loading', stop)
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('page-title-updated', onTitle)
    return () => {
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-navigate', sync)
      wv.removeEventListener('did-navigate-in-page', sync)
      wv.removeEventListener('did-start-loading', start)
      wv.removeEventListener('did-stop-loading', stop)
      wv.removeEventListener('dom-ready', onReady)
    }
  }, [chatKey, tabId])

  // lets this chat's Claude drive the page (browser_* MCP tools): always the tab you're looking at
  useEffect(() => {
    if (ready && active) window.api.browser.attach(chatKey, ref.current!.getWebContentsId())
  }, [ready, active, chatKey])

  // openBrowser(url) from elsewhere in the app: navigate there
  useEffect(() => {
    if (url !== shown.current) {
      shown.current = url
      setAddress(display(url))
      ref.current?.loadURL(url).catch(() => {})
    }
  }, [url])

  /*
   * Emulated screen: the page lays out at the device's size (e.g. 1920×1080), then is zoomed out
   * to fit this pane. Zoom (not a CSS transform) keeps clicks and scrolling exact.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const fit = (): void => {
      const W = stage.clientWidth
      const H = stage.clientHeight
      if (W < 20 || H < 20) return // hidden tab
      if (!device.w || !device.h) return setBox(null)
      const zoom = Math.min(1, (W - 16) / device.w, (H - 16) / device.h)
      setBox({ w: Math.floor(device.w * zoom), h: Math.floor(device.h * zoom), zoom })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [device.w, device.h])

  // apply the zoom (again after each page load: Chromium keeps zoom per site)
  const zoom = box?.zoom ?? 1
  useEffect(() => {
    if (!ready) return
    const wv = ref.current
    const apply = (): void => {
      try {
        wv?.setZoomFactor(zoom)
      } catch {
        /* webview not attached yet */
      }
    }
    apply()
    wv?.addEventListener('did-navigate', apply)
    wv?.addEventListener('did-stop-loading', apply)
    return () => {
      wv?.removeEventListener('did-navigate', apply)
      wv?.removeEventListener('did-stop-loading', apply)
    }
  }, [zoom, ready])

  const pickDevice = (key: string): void => {
    const next = DEVICES.find((d) => d.key === key) ?? DEVICES[0]
    try {
      localStorage.setItem(DEVICE_KEY, key)
    } catch {
      /* per-viewer convenience only */
    }
    // phone/tablet ↔ desktop changes the browser identity; the page reloads to pick it up
    if ((next.ua ?? '') !== (device.ua ?? '') && ready) {
      ref.current?.setUserAgent(next.ua ?? navigator.userAgent)
      ref.current?.reload()
    }
    setDeviceKey(key)
  }

  const [clearing, setClearing] = useState(false)
  const clearCache = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.app.clearBrowserCache()
      ref.current?.reloadIgnoringCache()
    } finally {
      setClearing(false)
    }
  }

  const go = (): void => {
    const url = toUrl(address)
    setAddress(url)
    ref.current?.loadURL(url).catch(() => {})
  }

  return (
    <div className="browser-tab">
      <div className="browser-bar">
        <button className="icon-btn" title="Back" disabled={!nav.back} onClick={() => ref.current?.goBack()}>
          <ArrowLeft size={15} />
        </button>
        <button className="icon-btn" title="Forward" disabled={!nav.fwd} onClick={() => ref.current?.goForward()}>
          <ArrowRight size={15} />
        </button>
        <button className="icon-btn" title={loading ? 'Stop' : 'Reload'} onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}>
          {loading ? <X size={15} /> : <RotateCw size={14} />}
        </button>
        <input
          className="browser-address"
          value={address}
          spellCheck={false}
          placeholder="Search or type a URL"
          autoFocus={!address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
        <div className="device-seg" role="radiogroup" aria-label="Screen size">
          <SlidePill />
          {DEVICES.map((d) => (
            <button key={d.key} role="radio" aria-checked={d.key === deviceKey} className={d.key === deviceKey ? 'on' : ''} title={d.label} onClick={() => pickDevice(d.key)}>
              {d.icon}
            </button>
          ))}
        </div>
        {box && <span className="device-zoom" title="Zoomed out to fit">{Math.round(box.zoom * 100)}%</span>}
        <button className="icon-btn" title="Clear cache & reload (keeps logins)" disabled={clearing} onClick={clearCache}>
          <Eraser size={14} />
        </button>
        <button className="icon-btn" title="Open in your browser" disabled={!address} onClick={() => window.api.app.openExternal(address)}>
          <ExternalLink size={14} />
        </button>
      </div>
      {loading && <div className="browser-progress" />}
      <div className={`browser-stage${box ? ' emulated' : ''}`} ref={stageRef}>
        <webview
          ref={ref as React.Ref<HTMLWebViewElement>}
          className="browser-view"
          style={box ? { width: box.w, height: box.h, flex: 'none' } : undefined}
          src={initial}
          partition="persist:tinjs-browser"
          {...(initialUa ? { useragent: initialUa } : {})}
        />
      </div>
    </div>
  )
}
