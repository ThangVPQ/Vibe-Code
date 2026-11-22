import { useEffect, useRef, useState } from 'react'
import { FilePlus2, FileSpreadsheet, FileStack, FileText, FileType2, FolderOpen, Home, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import type { OfficeRequest, RecentFile } from '../../../shared/types'
import { openMenu } from './ContextMenu'
import { DocsWorkspace } from './Docs'
import { OnlyOfficeWorkspace } from './OnlyOffice'
import { PdfWorkspace } from './Pdf'
import { SheetsWorkspace } from './Sheets'
import { type Kind, type Workspace, errText, fileName, folderOf, kindOf, ooOpens, samePath } from './officeShared'
import { setOfficeOpener } from '../actions'
import { type T, tr, useT } from '../i18n'
import './office.css'

type View = 'home' | Kind

const KINDS: { kind: Kind; label: string; icon: (size: number) => React.ReactNode; what: (t: T) => string }[] = [
  { kind: 'doc', label: 'Docs', icon: (s) => <FileText size={s} className="of-ic-doc" />, what: (t) => t('document', 'tài liệu') },
  { kind: 'sheet', label: 'Sheets', icon: (s) => <FileSpreadsheet size={s} className="of-ic-sheet" />, what: (t) => t('spreadsheet', 'bảng tính') },
  { kind: 'pdf', label: 'PDF', icon: (s) => <FileType2 size={s} className="of-ic-pdf" />, what: () => 'PDF' },
  { kind: 'oo', label: 'ONLYOFFICE', icon: (s) => <FileStack size={s} className="of-ic-oo" />, what: (t) => t('Word, Excel, PowerPoint file', 'file Word, Excel, PowerPoint') }
]
const label = (k: Kind): string => KINDS.find((x) => x.kind === k)!.label
/** "open .docx / .xlsx with ONLYOFFICE" (the home page's switch), kept in the browser storage */
const OO_DEFAULT_KEY = 'office-onlyoffice-default'
const kindIcon = (path: string, size = 18): React.ReactNode => KINDS.find((k) => k.kind === kindOf(path))?.icon(size) ?? <FileText size={size} />

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Office tab: a WPS-like home (open, new, recent files) and four workspaces — Docs (.docx),
 * Sheets (.xlsx/.csv), PDF and ONLYOFFICE (Word / Excel / PowerPoint with full formatting) — each
 * with its own file tabs. A file is open in one workspace at a time. Workspaces stay mounted, so open
 * files keep their state while another view is shown. Claude's vibe-office tools come in here
 * (`office:request`) and go to the workspace of their kind.
 */
export function OfficePane(): React.JSX.Element {
  const [view, setView] = useState<View>('home')
  const [open, setOpen] = useState<Record<Kind, string[]>>({ doc: [], sheet: [], pdf: [], oo: [] })
  const [ooDefault, setOoDefault] = useState(() => localStorage.getItem(OO_DEFAULT_KEY) === '1')
  const [recent, setRecent] = useState<RecentFile[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const docs = useRef<Workspace>(null)
  const sheets = useRef<Workspace>(null)
  const pdfs = useRef<Workspace>(null)
  const oo = useRef<Workspace>(null)
  const ws = (k: Kind): Workspace => {
    const w = { doc: docs, sheet: sheets, pdf: pdfs, oo }[k].current
    if (!w) throw new Error('Office tab is not ready')
    return w
  }

  const loadRecent = (): void => void window.api.office.recent().then(setRecent, () => setRecent([]))
  useEffect(loadRecent, [])

  /** opens (or `create`s) any supported file in a workspace (default: the one of its kind) and shows it */
  const openFile = async (path: string, create = false, kind = kindOf(path)): Promise<Kind> => {
    if (!kind) throw new Error(tr(`The Office tab can't open this kind of file: ${fileName(path)}`, `Tab Office chưa mở được loại file này: ${fileName(path)}`))
    if (create && kind === 'pdf') throw new Error(tr("Can't create a new PDF: only existing PDFs can be opened", 'Không tạo được PDF mới: chỉ mở PDF có sẵn'))
    // two editors saving over the same file would undo each other's edits
    const elsewhere = KINDS.find((k) => k.kind !== kind && open[k.kind].some((p) => samePath(p, path)))
    if (elsewhere) throw new Error(tr(`${fileName(path)} is open in ${elsewhere.label}: close it there, then open it again.`, `${fileName(path)} đang mở ở ${elsewhere.label}: đóng nó ở đó rồi mở lại.`))
    await ws(kind).open(path, create)
    setView(kind)
    await window.api.office.recentAdd(path).catch(() => {})
    loadRecent()
    return kind
  }
  const run = (p: () => Promise<unknown>): void => {
    setBusy(true)
    setError('')
    p()
      .catch((err: unknown) => setError(errText(err)))
      .finally(() => setBusy(false))
  }
  /** where the user's own opens go: .docx / .xlsx / .csv to ONLYOFFICE when the home page's switch is on */
  const userKind = (path: string): Kind | null => {
    const k = kindOf(path)
    return ooDefault && (k === 'doc' || k === 'sheet') ? 'oo' : k
  }
  const pickOpen = (kind?: Kind): void =>
    run(async () => {
      const p = await window.api.office.pick(false, kind)
      if (p) await openFile(p, false, kind === 'oo' ? 'oo' : kind ? kindOf(p) : userKind(p))
    })
  const pickNew = (kind: 'doc' | 'sheet'): void =>
    run(async () => {
      let p = await window.api.office.pick(true, kind)
      if (!p) return
      if (!kindOf(p)) p += kind === 'doc' ? '.docx' : '.xlsx'
      await openFile(p, true)
    })
  const addMenu = (kind: Kind) => (e: React.MouseEvent) =>
    openMenu(e, [
      { label: tr(`Open ${KINDS.find((k) => k.kind === kind)!.what(tr)}…`, `Mở ${KINDS.find((k) => k.kind === kind)!.what(tr)}…`), icon: <FolderOpen size={14} />, action: () => pickOpen(kind) },
      (kind === 'doc' || kind === 'sheet') && { label: kind === 'doc' ? tr('New document…', 'Tài liệu mới…') : tr('New spreadsheet…', 'Bảng tính mới…'), icon: <FilePlus2 size={14} />, action: () => pickNew(kind) }
    ])

  /* ---------- Claude's tools: one at a time, in order ---------- */
  const tool = async (req: OfficeRequest): Promise<string> => {
    switch (req.tool) {
      case 'office_status': {
        const parts = KINDS.flatMap((k) => ws(k.kind).status().map((s) => `${k.label}: ${s}`))
        return parts.length ? `On screen: ${view === 'home' ? 'the Office home page' : KINDS.find((k) => k.kind === view)!.label}\n${parts.join('\n')}` : 'No file is open in the Office tab. Use office_open.'
      }
      case 'office_open': {
        const path = typeof req.args.path === 'string' ? req.args.path : ''
        if (!path) throw new Error('missing `path`')
        const kind = await openFile(path, req.args.create === true)
        return ws(kind).status().find((s) => s.includes(path)) ?? `Opened ${path}`
      }
      case 'sheet_read':
      case 'sheet_save':
        return ws('sheet').tool(req)
      case 'sheet_write':
        setView('sheet')
        return ws('sheet').tool(req)
      case 'doc_read':
        return ws('doc').tool(req)
      case 'doc_write':
        setView('doc')
        return ws('doc').tool(req)
      case 'pdf_read':
        return ws('pdf').tool(req)
    }
    throw new Error(`unknown tool ${String(req.tool)}`)
  }
  const toolRef = useRef(tool)
  toolRef.current = tool
  // files opened from Source code › This PC
  const openRef = useRef(openFile)
  openRef.current = openFile
  const userKindRef = useRef(userKind)
  userKindRef.current = userKind
  useEffect(() => setOfficeOpener((path) => run(() => openRef.current(path, false, userKindRef.current(path)))), [])
  useEffect(() => {
    let chain = Promise.resolve()
    const seen = new Set<number>()
    const handle = (req: OfficeRequest): void => {
      if (seen.has(req.id)) return
      seen.add(req.id)
      chain = chain.then(() =>
        toolRef.current(req).then(
          (text) => window.api.office.reply(req.id, true, text),
          (err: unknown) => window.api.office.reply(req.id, false, errText(err))
        )
      )
    }
    const off = window.api.office.onRequest(handle)
    void window.api.office.pending().then((list) => list.forEach(handle))
    return off
  }, [])

  const filesChanged = (kind: Kind) => (paths: string[]) => setOpen((o) => ({ ...o, [kind]: paths }))
  const homeFor: Kind | null = view === 'home' ? null : view
  const showHome = view === 'home' || open[view].length === 0
  // sizes and dates change as files are saved: refresh the list whenever it comes back on screen
  useEffect(() => {
    if (showHome) loadRecent()
  }, [showHome, view])

  const t = useT()
  return (
    <div className="of-root of-shell">
      <nav className="of-rail">
        <button className={view === 'home' ? 'on' : ''} onClick={() => setView('home')} title={t('Home', 'Trang chủ')}>
          <Home size={20} />
          <span>{t('Home', 'Trang chủ')}</span>
        </button>
        {KINDS.map((k) => (
          <button key={k.kind} className={view === k.kind ? 'on' : ''} onClick={() => setView(k.kind)} title={k.label}>
            {k.icon(20)}
            <span>{k.label}</span>
            {open[k.kind].length > 0 && <i className="of-rail-count">{open[k.kind].length}</i>}
          </button>
        ))}
      </nav>
      <main className="of-main">
        <DocsWorkspace ref={docs} shown={view === 'doc'} onFiles={filesChanged('doc')} onAdd={addMenu('doc')} />
        <SheetsWorkspace ref={sheets} shown={view === 'sheet'} onFiles={filesChanged('sheet')} onAdd={addMenu('sheet')} />
        <PdfWorkspace ref={pdfs} shown={view === 'pdf'} onFiles={filesChanged('pdf')} onAdd={addMenu('pdf')} />
        <OnlyOfficeWorkspace ref={oo} shown={view === 'oo'} onFiles={filesChanged('oo')} onAdd={addMenu('oo')} />
        {showHome && (
          <OfficeHome
            kind={homeFor}
            recent={recent}
            busy={busy}
            error={error}
            onClearError={() => setError('')}
            onOpen={(p, kind) => run(() => openFile(p, false, kind ?? userKind(p)))}
            onPick={() => pickOpen(homeFor ?? undefined)}
            onPickOo={() => pickOpen('oo')}
            ooDefault={ooDefault}
            onOoDefault={(on) => {
              localStorage.setItem(OO_DEFAULT_KEY, on ? '1' : '0')
              setOoDefault(on)
            }}
            onNew={pickNew}
            onRefresh={loadRecent}
            onForget={(p) => void window.api.office.recentAdd(p, true).then(loadRecent)}
          />
        )}
      </main>
    </div>
  )
}

/* ================================ home ================================ */

function OfficeHome(p: {
  kind: Kind | null
  recent: RecentFile[] | null
  busy: boolean
  error: string
  onClearError: () => void
  /** `kind`: the workspace to open it in (default: where the user's opens go) */
  onOpen: (path: string, kind?: Kind) => void
  onPick: () => void
  onPickOo: () => void
  ooDefault: boolean
  onOoDefault: (on: boolean) => void
  onNew: (kind: 'doc' | 'sheet') => void
  onRefresh: () => void
  onForget: (path: string) => void
}): React.JSX.Element {
  const list = (p.recent ?? []).filter((f) => !p.kind || (p.kind === 'oo' ? ooOpens(f.path) : kindOf(f.path) === p.kind))
  const t = useT()
  const what = p.kind ? KINDS.find((k) => k.kind === p.kind)!.what(t) : null
  return (
    <div className="of-home">
      <div className="of-home-actions">
        <button className="of-open" disabled={p.busy} onClick={p.onPick}>
          {p.busy ? <Loader2 size={16} className="of-spin" /> : <FolderOpen size={16} />} {t('Open', 'Mở')}{what ? ` ${what}` : ''}
        </button>
        {(!p.kind || p.kind === 'doc') && (
          <button className="of-action" disabled={p.busy} onClick={() => p.onNew('doc')}>
            <FilePlus2 size={16} className="of-ic-doc" /> {t('New document', 'Tài liệu mới')}
          </button>
        )}
        {(!p.kind || p.kind === 'sheet') && (
          <button className="of-action" disabled={p.busy} onClick={() => p.onNew('sheet')}>
            <FilePlus2 size={16} className="of-ic-sheet" /> {t('New spreadsheet', 'Bảng tính mới')}
          </button>
        )}
        {(!p.kind || p.kind === 'doc' || p.kind === 'sheet') && (
          <button
            className="of-action"
            disabled={p.busy}
            onClick={p.onPickOo}
            title={t(
              'Word, Excel, PowerPoint with full formatting. The first time downloads ONLYOFFICE (about 210 MB); after that it runs right on this computer, offline, with no ads.',
              'Word, Excel, PowerPoint giữ đầy đủ định dạng. Lần đầu tải bộ ONLYOFFICE (khoảng 210 MB), sau đó chạy ngay trên máy, không cần mạng, không quảng cáo.'
            )}
          >
            <FileStack size={16} className="of-ic-oo" /> {t('Open with ONLYOFFICE', 'Mở bằng ONLYOFFICE')}
          </button>
        )}
        {(!p.kind || p.kind === 'oo') && (
          <label
            className="of-home-opt"
            title={t(
              "On: .docx, .xlsx, .csv opened from this page and from This PC go to ONLYOFFICE instead of Docs / Sheets. Claude's tools still use Docs / Sheets.",
              'Bật: .docx, .xlsx, .csv mở từ trang này và từ This PC sẽ vào ONLYOFFICE thay cho Docs / Sheets. Công cụ của Claude vẫn dùng Docs / Sheets.'
            )}
          >
            <input type="checkbox" checked={p.ooDefault} onChange={(e) => p.onOoDefault(e.target.checked)} /> {t('Always open Word / Excel with ONLYOFFICE', 'Luôn mở Word / Excel bằng ONLYOFFICE')}
          </label>
        )}
      </div>
      {p.error && (
        <p className="of-error of-pad" onClick={p.onClearError} title={t('Click to hide', 'Bấm để ẩn')}>
          {p.error}
        </p>
      )}
      <div className="of-recent-head">
        <h2>{p.kind ? t(`Recent ${KINDS.find((k) => k.kind === p.kind)!.label}`, `${KINDS.find((k) => k.kind === p.kind)!.label} gần đây`) : t('Recent', 'Gần đây')}</h2>
        <button className="of-tb" title={t('Refresh', 'Tải lại')} onClick={p.onRefresh}>
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="of-recent">
        <div className="of-recent-row of-recent-cols">
          <span>{t('Name', 'Tên file')}</span>
          <span>{t('Location', 'Vị trí')}</span>
          <span>{t('Date modified', 'Sửa lần cuối')}</span>
          <span className="of-num">{t('Size', 'Dung lượng')}</span>
          <span />
        </div>
        {p.recent === null && <p className="of-dim of-pad">{t('Loading…', 'Đang tải…')}</p>}
        {p.recent !== null && list.length === 0 && (
          <p className="of-dim of-pad">
            {t(
              `No ${what ?? 'file'}s yet. Click “Open${what ? ` ${what}` : ''}” to open a file on this computer${p.kind === 'pdf' || p.kind === 'oo' ? '' : ' or create a new one'}.`,
              `Chưa có ${what ?? 'file'} nào. Bấm “Mở${what ? ` ${what}` : ''}” để mở file trên máy${p.kind === 'pdf' || p.kind === 'oo' ? '' : ' hoặc tạo mới'}.`
            )}
          </p>
        )}
        {list.map((f) => (
          <div
            key={f.path}
            className={'of-recent-row' + (f.exists ? '' : ' gone')}
            title={f.exists ? f.path : t(`The file is no longer at ${f.path}`, `Không còn file ở ${f.path}`)}
            onClick={() => f.exists && p.onOpen(f.path)}
            onContextMenu={(e) =>
              openMenu(e, [
                f.exists && { label: t('Open', 'Mở'), action: () => p.onOpen(f.path) },
                f.exists && ooOpens(f.path) && kindOf(f.path) !== 'oo' && { label: t('Open with ONLYOFFICE', 'Mở bằng ONLYOFFICE'), icon: <FileStack size={14} />, action: () => p.onOpen(f.path, 'oo') },
                f.exists && (kindOf(f.path) === 'doc' || kindOf(f.path) === 'sheet') && { label: t(`Open with ${label(kindOf(f.path)!)}`, `Mở bằng ${label(kindOf(f.path)!)}`), action: () => p.onOpen(f.path, kindOf(f.path)!) },
                f.exists && { label: t('Open containing folder', 'Mở thư mục chứa'), icon: <FolderOpen size={14} />, action: () => window.api.fs.reveal(f.path) },
                { label: t('Remove from list', 'Xoá khỏi danh sách'), icon: <Trash2 size={14} />, action: () => p.onForget(f.path) }
              ])
            }
          >
            <span className="of-recent-name">
              {kindIcon(f.path)}
              <b>{fileName(f.path)}</b>
              {!f.exists && <em>{t('no longer on this computer', 'không còn trên máy')}</em>}
            </span>
            <span className="of-dim of-ellipsis">{folderOf(f.path)}</span>
            <span className="of-dim">{f.modified ? new Date(f.modified).toLocaleDateString(t('en-US', 'vi-VN'), { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''}</span>
            <span className="of-dim of-num">{f.exists ? bytes(f.size) : ''}</span>
            <button
              className="of-fileclose"
              title={t('Remove from list (does not delete the file)', 'Xoá khỏi danh sách (không xoá file)')}
              onClick={(e) => {
                e.stopPropagation()
                p.onForget(f.path)
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
