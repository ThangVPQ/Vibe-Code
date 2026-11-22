import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Bot, FileSpreadsheet, Loader2, Save } from 'lucide-react'
import { Workbook, type WorkbookInstance } from '@fortune-sheet/react'
import type { Sheet } from '@fortune-sheet/core'
import '@fortune-sheet/react/dist/index.css'
import { transformExcelToFortune, transformFortuneToExcel } from '@corbe30/fortune-excel'
import type { OfficeRequest } from '../../../shared/types'
import { newChatFromOfficeFile } from '../actions'
import { type FSheet, csvSheet, matrix, parseCell, readText, sheetRows, toCelldata, usedSize } from '../sheetData'
import { FileTabs, SaveStatus, type Workspace, type WorkspaceProps, errText, fileName, findOpen, isCsv, samePath, toBase64, until, useAutosave } from './officeShared'
import { type T, tr, useT } from '../i18n'

const csvNote = (t: T): string =>
  t(
    'A .csv file only saves the values of the first sheet (no formatting, no formulas). To keep formatting, save as .xlsx.',
    'File .csv chỉ lưu giá trị của sheet đầu tiên (không có định dạng, công thức). Muốn giữ định dạng: lưu thành .xlsx.'
  )

type OpenFile = { path: string; sheets: Sheet[]; dirty: boolean }

/* ================================ files ================================ */

async function loadFile(path: string): Promise<Sheet[]> {
  if (isCsv(path)) {
    const rows = await window.api.office.readCsv(path)
    return [csvSheet(fileName(path).replace(/\.csv$/i, ''), rows) as Sheet]
  }
  const bytes = await window.api.office.readFile(path)
  let sheets: Sheet[] = []
  await transformExcelToFortune(new File([bytes], fileName(path)), (s: Sheet[]) => (sheets = s), () => {}, { current: null })
  if (!sheets.length) throw new Error(tr(`Could not read ${fileName(path)}`, `Không đọc được ${fileName(path)}`))
  return sheets
}

/**
 * What the export needs: each sheet's cell matrix (a sheet never shown has just `celldata`), and a
 * value in every formula cell — the export skips cells without one, which would drop the formula.
 */
const withData = (sheets: Sheet[]): Sheet[] =>
  sheets.map((s) => {
    const m = matrix(s as FSheet).map((row) => row?.map((c) => (c?.f && c.v == null ? { ...c, v: '' } : c)))
    // an empty sheet is skipped by the export: keep it (a workbook needs at least one sheet)
    return { ...s, data: (m.length ? m : [[null]]) as Sheet['data'] }
  })

/** formula cells not calculated yet */
const uncalculated = (sheets: Sheet[]): boolean => sheets.some((s) => s.data?.some((row) => row?.some((c) => c?.f && c.v == null)))

async function writeFile(path: string, sheets: Sheet[]): Promise<void> {
  if (isCsv(path)) return window.api.office.writeCsv(path, sheetRows(sheets[0] as FSheet))
  const all = withData(sheets)
  const blob: Blob = await transformFortuneToExcel({ current: { getAllSheets: () => all, getSheet: () => all[0] } }, 'xlsx' as never, false)
  await window.api.office.writeFile(path, toBase64(await blob.arrayBuffer()))
}

const newSheets = (path: string): Sheet[] => [{ name: isCsv(path) ? fileName(path).replace(/\.csv$/i, '') : 'Sheet1', order: 0, status: 1, celldata: [] }]

/* ================================ workspace ================================ */

/**
 * Office tab → Sheets: .xlsx / .csv files, one file tab each, shown in FortuneSheet (Excel-like
 * editing, formatting, formulas, merges, filters, freezing…). Only the file on screen has a mounted
 * workbook; the others wait as snapshots.
 */
export const SheetsWorkspace = forwardRef<Workspace, WorkspaceProps>(function SheetsWorkspace({ shown, onFiles, onAdd }, ref) {
  const [files, setFiles] = useState<OpenFile[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const wb = useRef<WorkbookInstance>(null)
  /** the file whose workbook is mounted (set after it renders) */
  const mounted = useRef<string | null>(null)
  /** what each workbook last reported: the files' current sheets (the `sheets` in state are only the starting point) */
  const live = useRef(new Map<string, Sheet[]>())
  /** edits made by the app itself (recalculating on open): not the user's, so the file stays clean */
  const quiet = useRef(false)
  const filesRef = useRef(files)
  filesRef.current = files
  const activeRef = useRef(active)
  activeRef.current = active
  const gridRef = useRef<HTMLDivElement>(null)

  const file = files.find((f) => f.path === active) ?? null
  useEffect(() => {
    mounted.current = active
  }, [active])
  useEffect(() => onFiles(files.map((f) => f.path)), [files.length])

  /** current sheets of an open file */
  const sheetsOf = (path: string): Sheet[] => {
    if (path === activeRef.current && mounted.current === path && wb.current) return wb.current.getAllSheets()
    return live.current.get(path) ?? filesRef.current.find((f) => f.path === path)?.sheets ?? []
  }
  const setDirty = (path: string, dirty: boolean): void =>
    setFiles((fs) => (fs.some((f) => f.path === path && f.dirty !== dirty) ? fs.map((f) => (f.path === path ? { ...f, dirty } : f)) : fs))

  /** calculates every formula (a file from exceljs/other tools may hold formulas without results) */
  const recalc = async (w: WorkbookInstance): Promise<void> => {
    if (!uncalculated(w.getAllSheets())) return
    quiet.current = true
    try {
      for (const s of w.getAllSheets()) if (s.id) w.calculateFormula(s.id)
      await until(() => !uncalculated(w.getAllSheets()))
    } finally {
      quiet.current = false
    }
  }
  const auto = useAutosave({
    isOpen: (path) => filesRef.current.some((f) => f.path === path),
    setDirty,
    write: async (path) => {
      const w = mounted.current === path ? wb.current : null
      if (w) await recalc(w)
      await writeFile(path, w ? w.getAllSheets() : sheetsOf(path))
    }
  })

  /** shows a file; resolves once its workbook is on screen */
  const show = async (path: string): Promise<WorkbookInstance> => {
    const cur = activeRef.current
    if (cur && cur !== path && mounted.current === cur && wb.current) {
      const all = wb.current.getAllSheets()
      // an edit still waiting for its autosave is written now, from the workbook about to close
      if (auto.pending(cur)) void auto.saveNow(cur, () => writeFile(cur, all)).catch(() => {})
      // the outgoing workbook remounts from here when it is shown again
      const snap = all.map((s) => toCelldata(s as FSheet) as Sheet)
      setFiles((fs) => fs.map((f) => (f.path === cur ? { ...f, sheets: snap } : f)))
    }
    setActive(path)
    for (let i = 0; i < 200; i++) {
      if (mounted.current === path && wb.current) return wb.current
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(tr('The spreadsheet could not be shown', 'Bảng tính chưa hiện lên được'))
  }

  const openPath = async (path: string, create = false): Promise<void> => {
    const open = filesRef.current.find((f) => samePath(f.path, path))
    if (open) {
      await show(open.path)
      return
    }
    const sheets = create ? newSheets(path) : await loadFile(path)
    if (create) {
      await writeFile(path, sheets)
      auto.created(path)
    }
    live.current.delete(path)
    setFiles((fs) => [...fs, { path, sheets, dirty: false }])
    await recalc(await show(path))
  }

  const run = (p: () => Promise<unknown>): void => {
    setBusy(true)
    setError('')
    p()
      .catch((err: unknown) => setError(errText(err)))
      .finally(() => setBusy(false))
  }
  const close = (path: string): void => {
    const f = filesRef.current.find((x) => x.path === path)
    if (!f) return
    const drop = (): void => {
      live.current.delete(path)
      auto.forget(path)
      const rest = filesRef.current.filter((x) => x.path !== path)
      setFiles(rest)
      if (activeRef.current === path) {
        const i = filesRef.current.findIndex((x) => x.path === path)
        setActive(rest[Math.min(i, rest.length - 1)]?.path ?? null)
      }
    }
    if (!f.dirty) return drop()
    // the last edits are saved first; only a file that can't be written asks
    run(async () => {
      try {
        await auto.saveNow(path)
      } catch (err) {
        if (!(await window.api.ask(tr(`Could not save "${fileName(path)}":\n${errText(err)}\n\nClose anyway and discard the unsaved changes?`, `Không lưu được "${fileName(path)}":\n${errText(err)}\n\nVẫn đóng và bỏ các thay đổi chưa lưu?`)))) return
      }
      drop()
    })
  }

  /* ---------- Claude's tools ---------- */
  const status = (f: OpenFile): string => {
    const lines = [`${f.path === activeRef.current ? '[on screen] ' : ''}${f.path}${f.dirty ? ' (unsaved changes)' : ''}`]
    for (const s of sheetsOf(f.path)) {
      const u = usedSize(s as FSheet)
      lines.push(`- sheet "${s.name}": ${u.rows} rows × ${u.cols} columns used`)
    }
    return lines.join('\n')
  }
  const tool = async (req: OfficeRequest): Promise<string> => {
    const a = req.args
    const str = (k: string): string | undefined => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : undefined)
    const find = (): OpenFile => findOpen(filesRef.current, activeRef.current, a.file, 'spreadsheet')
    switch (req.tool) {
      case 'sheet_read': {
        const w = await show(find().path)
        const name = str('sheet')
        const sheet = name ? w.getAllSheets().find((s) => s.name.toLowerCase() === name.toLowerCase()) : w.getSheet()
        if (!sheet) throw new Error(`no sheet "${name}"`)
        return readText(sheet as FSheet, str('range'))
      }
      case 'sheet_write': {
        const f = find()
        const w = await show(f.path)
        const values = a.values
        if (!Array.isArray(values) || !values.every(Array.isArray)) throw new Error('`values` must be an array of rows (arrays)')
        const { r: r0, c: c0 } = parseCell(str('cell') ?? '')
        const name = str('sheet')
        let sheet = name ? w.getAllSheets().find((s) => s.name.toLowerCase() === name.toLowerCase()) : w.getSheet()
        if (!sheet && name) {
          if (isCsv(f.path)) throw new Error('a .csv file has only one sheet')
          const id = `ai-${Date.now()}`
          w.addSheet(id)
          w.setSheetName(name, { id })
          sheet = w.getSheet({ id })
        }
        if (!sheet?.id) throw new Error(`no sheet "${name}"`)
        const id = sheet.id
        w.activateSheet({ id })
        // grow the grid when the block runs past its edge
        const rowsNow = sheet.data?.length ?? 0
        const colsNow = sheet.data?.[0]?.length ?? 0
        const needRows = r0 + values.length - rowsNow
        const needCols = c0 + Math.max(...(values as unknown[][]).map((r) => r.length)) - colsNow
        if (needRows > 0) w.insertRowOrColumn('row', rowsNow - 1, needRows + 20, 'rightbottom', { id })
        if (needCols > 0) w.insertRowOrColumn('column', colsNow - 1, needCols + 5, 'rightbottom', { id })
        const calls: { name: string; args: unknown[] }[] = []
        ;(values as unknown[][]).forEach((row, i) =>
          row.forEach((v, j) => {
            if (v === null || v === undefined) return
            const value = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v === '' ? null : v
            calls.push({ name: 'setCellValue', args: [r0 + i, c0 + j, value, { id }] })
          })
        )
        w.batchCallApis(calls)
        // answer once the grid holds the last cell (Claude may read it right after)
        const last = calls[calls.length - 1]?.args as [number, number, unknown] | undefined
        if (last) {
          const [lr, lc, lv] = last
          const isF = typeof lv === 'string' && lv.startsWith('=')
          await until(() => {
            const cur = w.getCellValue(lr, lc, { id, type: isF ? 'f' : 'v' })
            return isF ? !!cur : String(cur ?? '') === String(lv ?? '')
          })
        }
        auto.changed(f.path)
        return `Wrote ${calls.length} cells to "${sheet.name}" from ${str('cell')?.toUpperCase()}. The file saves itself about a second later.`
      }
      case 'sheet_save': {
        const f = find()
        await auto.saveNow(f.path)
        return `Saved ${f.path}${isCsv(f.path) ? ' (values of the first sheet only: .csv)' : ''}`
      }
    }
    throw new Error(`unknown tool ${String(req.tool)}`)
  }
  useImperativeHandle(ref, () => ({ open: openPath, tool, status: () => filesRef.current.map(status) }))

  // Ctrl + wheel zooms: FortuneSheet zooms on Ctrl + / Ctrl − (it listens on the document)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: e.deltaY < 0 ? '+' : '-', ctrlKey: true, bubbles: true }))
    }
    el.addEventListener('wheel', wheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', wheel, { capture: true })
  }, [file !== null])

  const t = useT()
  if (!file) return null
  return (
    <div
      className={'of-ws' + (shown ? ' on' : '')}
      onKeyDownCapture={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          e.stopPropagation()
          run(() => auto.saveNow(file.path))
        }
      }}
    >
      <FileTabs files={files} active={active} icon={<FileSpreadsheet size={13} className="of-ic-sheet" />} onShow={(p) => run(() => show(p))} onClose={close} onAdd={onAdd} addTitle={t('Open another spreadsheet / create new', 'Mở bảng tính khác / tạo mới')}>
        {busy && <Loader2 size={15} className="of-spin of-dim" />}
        <SaveStatus dirty={file.dirty} s={auto.saveState[file.path]} note={isCsv(file.path) ? csvNote(t) : undefined} />
        <button className="of-tool" title={isCsv(file.path) ? `${t('Save', 'Lưu')} (Ctrl+S). ${csvNote(t)}` : `${t('Save', 'Lưu')} (Ctrl+S)`} disabled={!file.dirty || busy} onClick={() => run(() => auto.saveNow(file.path))}>
          <Save size={15} /> {t('Save', 'Lưu')}
        </button>
        <button className="of-tool of-ai" title={t('Open a Claude chat that works on this spreadsheet', 'Mở chat Claude làm việc với bảng tính này')} onClick={() => void newChatFromOfficeFile(file.path)}>
          <Bot size={15} /> {t('Hand to AI', 'Giao cho AI')}
        </button>
      </FileTabs>
      {error && (
        <p className="of-error of-pad" onClick={() => setError('')} title={t('Click to hide', 'Bấm để ẩn')}>
          {error}
        </p>
      )}
      <div className="of-book" ref={gridRef}>
        <Workbook
          key={file.path}
          ref={wb}
          data={file.sheets}
          lang="en"
          onChange={(d) => live.current.set(file.path, d)}
          onOp={() => !quiet.current && auto.changed(file.path)}
        />
      </div>
    </div>
  )
})
