import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronUp, FileType2, Minus, PanelLeft, Plus, Search } from 'lucide-react'
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './pdf-textlayer.css'
import type { OfficeRequest } from '../../../shared/types'
import { newChatFromOfficeFile } from '../actions'
import { FileTabs, type Workspace, type WorkspaceProps, errText, fileName, findOpen, samePath } from './officeShared'
import { tr, useT } from '../i18n'

GlobalWorkerOptions.workerSrc = workerUrl

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const GAP = 12

type OpenPdf = { path: string; doc: PDFDocumentProxy; sizes: { w: number; h: number }[] }

/** "1-5", "3", "1,4,7-9" → page numbers within 1…n (default: the first 20) */
export function pageList(spec: unknown, n: number): number[] {
  if (typeof spec !== 'string' || !spec.trim()) return Array.from({ length: Math.min(n, 20) }, (_, i) => i + 1)
  const out: number[] = []
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((x) => Number(x.trim()))
    if (!a) continue
    for (let p = a; p <= (b || a) && p <= n; p++) if (p >= 1 && !out.includes(p)) out.push(p)
  }
  return out
}

async function pageText(doc: PDFDocumentProxy, n: number): Promise<string> {
  const content = await (await doc.getPage(n)).getTextContent()
  return content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('')
}

/* ================================ workspace ================================ */

/** Office tab → PDF: a read-only viewer (pages, thumbnails, zoom, search, selectable text). */
export const PdfWorkspace = forwardRef<Workspace, WorkspaceProps>(function PdfWorkspace({ shown, onFiles, onAdd }, ref) {
  const [files, setFiles] = useState<OpenPdf[]>([])
  const [active, setActive] = useState<string | null>(null)
  const filesRef = useRef(files)
  filesRef.current = files
  const activeRef = useRef(active)
  activeRef.current = active
  const file = files.find((f) => f.path === active) ?? null
  useEffect(() => onFiles(files.map((f) => f.path)), [files.length])

  const openPath = async (path: string): Promise<void> => {
    const open = filesRef.current.find((f) => samePath(f.path, path))
    if (open) {
      activeRef.current = open.path
      return setActive(open.path)
    }
    const bytes = await window.api.office.readFile(path)
    const doc = await getDocument({ data: new Uint8Array(bytes) }).promise.catch((err: unknown) => {
      throw new Error(
        /password/i.test(errText(err))
          ? tr(`${fileName(path)} is password-protected: password-protected PDFs can't be opened yet.`, `${fileName(path)} có mật khẩu: chưa mở được PDF có mật khẩu.`)
          : tr(`Could not open ${fileName(path)}: ${errText(err)}`, `Không mở được ${fileName(path)}: ${errText(err)}`)
      )
    })
    const sizes: OpenPdf['sizes'] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 })
      sizes.push({ w: vp.width, h: vp.height })
    }
    filesRef.current = [...filesRef.current, { path, doc, sizes }]
    activeRef.current = path
    setFiles(filesRef.current)
    setActive(path)
  }
  const close = (path: string): void => {
    const f = filesRef.current.find((x) => x.path === path)
    if (!f) return
    void f.doc.loadingTask.destroy()
    const i = filesRef.current.indexOf(f)
    const rest = filesRef.current.filter((x) => x !== f)
    setFiles(rest)
    if (activeRef.current === path) setActive(rest[Math.min(i, rest.length - 1)]?.path ?? null)
  }

  const tool = async (req: OfficeRequest): Promise<string> => {
    const f = findOpen(filesRef.current, activeRef.current, req.args.file, 'PDF')
    if (req.tool !== 'pdf_read') throw new Error(`unknown tool ${req.tool}`)
    const pages = pageList(req.args.pages, f.doc.numPages)
    const parts = [`${fileName(f.path)}: ${f.doc.numPages} pages`]
    for (const n of pages) parts.push(`--- Page ${n} ---\n${(await pageText(f.doc, n)).trim() || '(no text on this page: a scanned image?)'}`)
    return parts.join('\n')
  }
  useImperativeHandle(ref, () => ({
    open: (path) => openPath(path),
    tool,
    status: () => filesRef.current.map((f) => `${f.path === activeRef.current ? '[on screen] ' : ''}${f.path}\n- PDF: ${f.doc.numPages} pages`)
  }))

  const t = useT()
  if (!file) return null
  return (
    <div className={'of-ws' + (shown ? ' on' : '')}>
      <FileTabs files={files.map((f) => ({ path: f.path, dirty: false }))} active={active} icon={<FileType2 size={13} className="of-ic-pdf" />} onShow={setActive} onClose={close} onAdd={onAdd} addTitle={t('Open another PDF', 'Mở PDF khác')}>
        <button className="of-tool of-ai" title={t('Open a Claude chat that works on this PDF', 'Mở chat Claude làm việc với PDF này')} onClick={() => void newChatFromOfficeFile(file.path)}>
          <Bot size={15} /> {t('Hand to AI', 'Giao cho AI')}
        </button>
      </FileTabs>
      <PdfView key={file.path} file={file} />
    </div>
  )
})

/* ================================ viewer ================================ */

function PdfView({ file }: { file: OpenPdf }): React.JSX.Element {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [page, setPage] = useState(1)
  const [thumbs, setThumbs] = useState(true)
  const [query, setQuery] = useState('')
  /** pages holding the query, and which of them is current */
  const [hits, setHits] = useState<{ pages: number[]; at: number } | null>(null)
  const texts = useRef(new Map<number, string>())
  const n = file.doc.numPages
  const tops: number[] = []
  let y = GAP
  for (const s of file.sizes) {
    tops.push(y)
    y += s.h * scale + GAP
  }
  const total = y

  const goTo = (p: number): void => {
    const el = scrollRef.current
    if (el && tops[p - 1] != null) el.scrollTop = tops[p - 1] - GAP
  }
  // keep the same page in view when zooming
  const shownScale = useRef(scale)
  useLayoutEffect(() => {
    const el = scrollRef.current
    const k = scale / shownScale.current
    shownScale.current = scale
    if (el && k !== 1) {
      el.scrollTop *= k
      el.scrollLeft *= k
    }
  }, [scale])
  // fit the page width the first time
  useLayoutEffect(() => {
    const el = scrollRef.current
    const w = Math.max(...file.sizes.map((s) => s.w))
    if (el && w) setScale(Math.min(1.5, Math.max(0.5, (el.clientWidth - 48) / w)))
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setScale((z) => (e.deltaY < 0 ? (ZOOMS.find((s) => s > z + 0.001) ?? z) : ([...ZOOMS].reverse().find((s) => s < z - 0.001) ?? z)))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const search = async (q: string, step = 0): Promise<void> => {
    const needle = q.trim().toLowerCase()
    if (!needle) return setHits(null)
    let found = hits && step ? hits.pages : null
    if (!found) {
      found = []
      for (let p = 1; p <= n; p++) {
        if (!texts.current.has(p)) texts.current.set(p, (await pageText(file.doc, p)).replace(/\n/g, ' ').toLowerCase())
        if (texts.current.get(p)!.includes(needle)) found.push(p)
      }
    }
    if (!found.length) return setHits({ pages: [], at: 0 })
    const at = step && hits?.pages.length ? (hits.at + step + found.length) % found.length : Math.max(0, found.findIndex((p) => p >= page))
    setHits({ pages: found, at })
    goTo(found[at])
  }

  return (
    <div className="of-pdf">
      <div className="of-pdf-bar">
        <button className={'of-tb' + (thumbs ? ' on' : '')} title={t('Page thumbnails', 'Trang thu nhỏ')} onClick={() => setThumbs((v) => !v)}>
          <PanelLeft size={15} />
        </button>
        <span className="of-tbsep" />
        <input
          className="of-pagebox"
          value={page}
          onChange={(e) => {
            const p = Number(e.target.value)
            if (p >= 1 && p <= n) goTo(p)
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <span className="of-dim">/ {n}</span>
        <span className="of-tbsep" />
        <button className="of-tb" title={t('Zoom out (Ctrl + mouse wheel)', 'Thu nhỏ (Ctrl + lăn chuột)')} onClick={() => setScale((z) => [...ZOOMS].reverse().find((s) => s < z - 0.001) ?? z)}>
          <Minus size={14} />
        </button>
        <button className="of-tb of-zoompct" title={t('Fit width', 'Vừa chiều rộng')} onClick={() => setScale(Math.min(3, Math.max(0.5, ((scrollRef.current?.clientWidth ?? 800) - 48) / Math.max(...file.sizes.map((s) => s.w)))))}>
          {Math.round(scale * 100)}%
        </button>
        <button className="of-tb" title={t('Zoom in (Ctrl + mouse wheel)', 'Phóng to (Ctrl + lăn chuột)')} onClick={() => setScale((z) => ZOOMS.find((s) => s > z + 0.001) ?? z)}>
          <Plus size={14} />
        </button>
        <span className="of-fill" />
        <form
          className="of-pdf-search"
          onSubmit={(e) => {
            e.preventDefault()
            void search(query, hits?.pages.length ? 1 : 0)
          }}
        >
          <Search size={14} />
          <input
            placeholder={t('Search in PDF', 'Tìm trong PDF')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHits(null)
            }}
          />
          {hits && <span className="of-dim">{hits.pages.length ? `${t('page', 'trang')} ${hits.pages[hits.at]} · ${hits.at + 1}/${hits.pages.length}` : t('not found', 'không thấy')}</span>}
          <button type="button" className="of-tb" title={t('Previous result', 'Kết quả trước')} disabled={!hits?.pages.length} onClick={() => void search(query, -1)}>
            <ChevronUp size={14} />
          </button>
          <button type="button" className="of-tb" title={t('Next result (Enter)', 'Kết quả sau (Enter)')} disabled={!hits?.pages.length} onClick={() => void search(query, 1)}>
            <ChevronDown size={14} />
          </button>
        </form>
      </div>
      <div className="of-pdf-body">
        {thumbs && (
          <div className="of-thumbs">
            {file.sizes.map((s, i) => (
              <button key={i} className={'of-thumb' + (page === i + 1 ? ' on' : '')} onClick={() => goTo(i + 1)}>
                <PageCanvas doc={file.doc} n={i + 1} scale={110 / s.w} />
                <span>{i + 1}</span>
              </button>
            ))}
          </div>
        )}
        <div
          className="of-pdf-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop + e.currentTarget.clientHeight / 3
            let p = 1
            while (p < n && tops[p] <= top) p++
            if (p !== page) setPage(p)
          }}
        >
          {/* centered while they fit; wider pages start at the left edge so all of them can be scrolled to */}
          <div className="of-pdf-pages" style={{ height: total, width: `max(100%, ${Math.max(...file.sizes.map((s) => s.w)) * scale + 2 * GAP}px)` }}>
            {file.sizes.map((s, i) => (
              <div key={i} className="of-pdf-page" style={{ top: tops[i], left: `max(${GAP}px, calc(50% - ${(s.w * scale) / 2}px))`, width: s.w * scale, height: s.h * scale }}>
                <PageCanvas doc={file.doc} n={i + 1} scale={scale} text query={hits?.pages.length ? query : ''} root={scrollRef} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** One page, drawn when it comes near the screen (and again when the zoom changes). */
function PageCanvas({ doc, n, scale, text, query = '', root }: { doc: PDFDocumentProxy; n: number; scale: number; text?: boolean; query?: string; root?: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [spans, setSpans] = useState<HTMLElement[]>([])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root?.current ?? null, rootMargin: '800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    const el = box.current
    if (!near || !el) return
    let cancelled = false
    let task: { cancel(): void } | null = null
    let layer: TextLayer | null = null
    void (async () => {
      const page = await doc.getPage(n)
      if (cancelled) return
      const vp = page.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(vp.width * ratio)
      canvas.height = Math.floor(vp.height * ratio)
      canvas.style.width = `${vp.width}px`
      canvas.style.height = `${vp.height}px`
      const render = page.render({ canvas, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      task = render
      await render.promise.catch(() => {})
      if (cancelled) return
      el.replaceChildren(canvas)
      if (!text) return
      const div = document.createElement('div')
      div.className = 'textLayer'
      el.appendChild(div)
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: div, viewport: vp })
      await layer.render().catch(() => {})
      if (!cancelled) setSpans(layer.textDivs)
    })()
    return () => {
      cancelled = true
      task?.cancel()
      layer?.cancel()
    }
  }, [near, scale])
  // highlight the text pieces holding the searched words
  useEffect(() => {
    const needle = query.trim().toLowerCase()
    for (const s of spans) s.classList.toggle('of-hit', !!needle && (s.textContent ?? '').toLowerCase().includes(needle))
  }, [spans, query])
  return <div ref={box} className="of-pdf-canvas" style={{ '--scale-factor': scale, '--total-scale-factor': scale, '--user-unit': 1 } as React.CSSProperties} />
}
