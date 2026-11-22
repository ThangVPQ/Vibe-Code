import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FileOutput, FileStack, Loader2, RefreshCw } from 'lucide-react'
import { FileTabs, SaveStatus, type Workspace, type WorkspaceProps, errText, fileName, samePath, toBase64, useAutosave } from './officeShared'
import { type T, tr, useT } from '../i18n'

/** Old binary formats: x2t reads them but writes only their OOXML sibling, so they open read-only. */
const LEGACY: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' }
const legacyTarget = (path: string): string | undefined => LEGACY[path.split('.').pop()?.toLowerCase() ?? '']
const note = (t: T): string =>
  t('Opened with ONLYOFFICE: keeps full Word / Excel / PowerPoint formatting. Saves itself a few seconds after each edit.', 'Mở bằng ONLYOFFICE: giữ đầy đủ định dạng Word / Excel / PowerPoint. Tự lưu vài giây sau khi sửa.')

type OpenFile = {
  path: string
  dirty: boolean
  state: 'loading' | 'ready' | 'error'
  error?: string
  /** bumped to load the editor again after an error */
  gen: number
  /** the editor's UI language, fixed when the file opens (changing it would reload the editor) */
  locale: string
}
type Waiting = { resolve: (payload: Record<string, unknown>) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }

let seq = 0

/**
 * Office tab → ONLYOFFICE: the full Word, Excel and PowerPoint editors (onlyoffice.rs downloads them
 * once and serves them from this machine). Each open file has its own editor iframe, driven through
 * the editor's embed API: the file's bytes go in with `document:open-buffer`; once edits stop,
 * `document:save` hands back the new file, written over the original (which is first copied to the
 * backup folder, as in Docs and Sheets).
 */
export const OnlyOfficeWorkspace = forwardRef<Workspace, WorkspaceProps>(function OnlyOfficeWorkspace({ shown, onFiles, onAdd }, ref) {
  const [files, setFiles] = useState<OpenFile[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [origin, setOrigin] = useState<string | null>(null)
  const [install, setInstall] = useState<{ done: number; total: number } | { error: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const filesRef = useRef(files)
  filesRef.current = files
  const originRef = useRef(origin)
  const installing = useRef(false)
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const waiting = useRef(new Map<string, Waiting>())
  const file = files.find((f) => f.path === active) ?? null
  useEffect(() => onFiles(files.map((f) => f.path)), [files.length])

  const patch = (path: string, p: Partial<OpenFile>): void => {
    filesRef.current = filesRef.current.map((f) => (f.path === path ? { ...f, ...p } : f))
    setFiles(filesRef.current)
  }

  /** one embed API command to a file's editor; resolves with its answer's payload */
  const call = (path: string, type: string, payload: Record<string, unknown>, ms: number, transfer: Transferable[] = []): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const win = frames.current.get(path)?.contentWindow
      if (!win || !originRef.current) return reject(new Error(tr('ONLYOFFICE is not ready yet', 'ONLYOFFICE chưa sẵn sàng')))
      const id = `vibe-${++seq}`
      const timer = setTimeout(() => {
        waiting.current.delete(id)
        reject(new Error(tr('ONLYOFFICE did not answer in time', 'ONLYOFFICE không trả lời kịp')))
      }, ms)
      waiting.current.set(id, { resolve, reject, timer })
      win.postMessage({ id, type, payload }, { targetOrigin: originRef.current, transfer })
    })

  /** the editor of `path` is up: give it the file */
  const load = async (path: string): Promise<void> => {
    try {
      const bytes = await window.api.office.readFile(path)
      await call(path, 'document:open-buffer', { fileName: fileName(path), buffer: bytes, readonly: !!legacyTarget(path) }, 180_000, [bytes])
      patch(path, { state: 'ready', error: undefined })
    } catch (err) {
      patch(path, { state: 'error', error: tr(`Could not open ${fileName(path)}: ${errText(err)}`, `Không mở được ${fileName(path)}: ${errText(err)}`) })
    }
  }

  /** the file as the editor has it now, in `targetExt` (default: its own format) */
  const exportFile = async (path: string, targetExt?: string): Promise<{ data: string; dirty: boolean }> => {
    const p = await call(path, 'document:save', targetExt ? { targetExt } : {}, 300_000)
    const out = p.file
    if (!(out instanceof Blob) || out.size === 0) throw new Error(tr('ONLYOFFICE returned an empty file', 'ONLYOFFICE trả về file rỗng'))
    return { data: toBase64(await out.arrayBuffer()), dirty: p.dirty === true }
  }

  /** what was last written to each file (the same bytes are not written again) */
  const written = useRef(new Map<string, string>())
  /** files to export again later: the editor has edits no export holds yet */
  const recheck = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const stopRecheck = (path: string): void => {
    clearTimeout(recheck.current.get(path))
    recheck.current.delete(path)
  }
  const isOpen = (path: string): boolean => filesRef.current.some((f) => f.path === path)

  const auto = useAutosave({
    delay: 2000,
    write: async (path) => {
      stopRecheck(path)
      const { data, dirty } = await exportFile(path)
      const same = written.current.get(path) === data
      if (!same) {
        await window.api.office.writeFile(path, data)
        written.current.set(path, data)
      }
      if (!dirty) return
      // The editor still has edits these bytes lack: typed while the file was exported (saved
      // again right away), or a spreadsheet cell still being typed into, which no export holds
      // until it is committed (looked at again a little later, without writing the same bytes).
      if (!same) auto.changed(path)
      else
        recheck.current.set(
          path,
          setTimeout(() => {
            recheck.current.delete(path)
            if (isOpen(path)) auto.changed(path)
          }, 15_000)
        )
    },
    isOpen,
    setDirty: (path, dirty) => patch(path, { dirty })
  })

  const onMessage = (e: MessageEvent): void => {
    if (!originRef.current || e.origin !== originRef.current) return
    const path = [...frames.current].find(([, f]) => f.contentWindow === e.source)?.[0]
    const { id, type, payload = {} } = (e.data ?? {}) as { id?: string; type?: string; payload?: Record<string, unknown> }
    if (!path || typeof type !== 'string') return
    const w = id ? waiting.current.get(id) : undefined
    if (w) {
      clearTimeout(w.timer)
      waiting.current.delete(id!)
      if (type === 'document:error') w.reject(new Error(String(payload.message ?? tr('unknown error', 'lỗi không rõ'))))
      else w.resolve(payload)
      return
    }
    if (type === 'document:ready') void load(path)
    else if (type === 'document:dirty-changed' && payload.dirty === true) auto.changed(path)
  }
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  useEffect(() => {
    const handle = (e: MessageEvent): void => onMessageRef.current(e)
    window.addEventListener('message', handle)
    const off = window.api.onlyoffice.onProgress((done, total) => setInstall({ done, total }))
    return () => {
      window.removeEventListener('message', handle)
      off()
    }
  }, [])

  /** the editor's address, downloading it the first time */
  const ensureEditor = async (): Promise<void> => {
    if (originRef.current || installing.current) return
    installing.current = true
    try {
      let o = await window.api.onlyoffice.origin()
      if (!o) {
        setInstall({ done: 0, total: await window.api.onlyoffice.downloadSize() })
        o = await window.api.onlyoffice.install()
      }
      originRef.current = o
      setOrigin(o)
      setInstall(null)
    } catch (err) {
      setInstall({ error: errText(err) })
    } finally {
      installing.current = false
    }
  }

  const openPath = async (path: string, create?: boolean): Promise<void> => {
    if (create) throw new Error(tr('ONLYOFFICE only opens existing files: create new documents / spreadsheets in Docs, Sheets', 'ONLYOFFICE chỉ mở file có sẵn: tạo tài liệu / bảng tính mới ở Docs, Sheets'))
    const open = filesRef.current.find((f) => samePath(f.path, path))
    if (!open) {
      filesRef.current = [...filesRef.current, { path, dirty: false, state: 'loading', gen: 0, locale: tr('en', 'vi') }]
      setFiles(filesRef.current)
    }
    setActive(open?.path ?? path)
    void ensureEditor()
  }

  const close = (path: string): void => {
    const f = filesRef.current.find((x) => x.path === path)
    if (!f) return
    const drop = (): void => {
      auto.forget(path)
      stopRecheck(path)
      written.current.delete(path)
      frames.current.delete(path)
      const i = filesRef.current.findIndex((x) => x.path === path)
      const rest = filesRef.current.filter((x) => x.path !== path)
      filesRef.current = rest
      setFiles(rest)
      setActive((a) => (a === path ? (rest[Math.min(i, rest.length - 1)]?.path ?? null) : a))
    }
    if (!f.dirty && !recheck.current.has(path)) return drop()
    // the last edits are saved first; only a file that can't be written asks
    void (async () => {
      try {
        await auto.saveNow(path)
      } catch (err) {
        if (!(await window.api.ask(tr(`Could not save "${fileName(path)}":\n${errText(err)}\n\nClose anyway and discard the unsaved changes?`, `Không lưu được "${fileName(path)}":\n${errText(err)}\n\nVẫn đóng và bỏ các thay đổi chưa lưu?`)))) return
      }
      drop()
    })()
  }

  /** a .doc / .xls / .ppt saved as .docx / .xlsx / .pptx beside it, and opened for editing */
  const convert = (path: string, ext: string): void => {
    setBusy(true)
    setError('')
    void (async () => {
      const to = path.replace(/\.[^.\\/]+$/, `.${ext}`)
      const exists = await window.api.office.readFile(to).then(
        () => true,
        () => false
      )
      if (exists && !(await window.api.ask(tr(`"${fileName(to)}" already exists. Overwrite it?`, `Đã có file "${fileName(to)}". Ghi đè lên nó?`)))) return
      if (exists) await window.api.office.backup(to)
      // a read-only editor refuses to export; the tab closes right after
      await call(path, 'document:set-readonly', { readonly: false }, 10_000)
      await window.api.office.writeFile(to, (await exportFile(path, ext.toUpperCase())).data)
      await window.api.office.recentAdd(to).catch(() => {})
      close(path)
      await openPath(to)
    })()
      .catch((err: unknown) => setError(tr(`Could not convert ${fileName(path)}: ${errText(err)}`, `Không chuyển được ${fileName(path)}: ${errText(err)}`)))
      .finally(() => setBusy(false))
  }

  useImperativeHandle(ref, () => ({
    open: openPath,
    tool: () => Promise.reject(new Error('Claude cannot edit files open in ONLYOFFICE; open the file in Docs / Sheets instead')),
    status: () =>
      filesRef.current.map((f) => `${f.path === active ? '[on screen] ' : ''}${f.path}${f.dirty ? ' (unsaved changes)' : ''}\n- open in the ONLYOFFICE editor (the doc_ / sheet_ tools cannot reach it)`)
  }))

  const t = useT()
  if (!file) return null
  const legacy = legacyTarget(file.path)
  const failed = install && 'error' in install ? install.error : null
  return (
    <div className={'of-ws' + (shown ? ' on' : '')}>
      <FileTabs files={files} active={active} icon={<FileStack size={13} className="of-ic-oo" />} onShow={setActive} onClose={close} onAdd={onAdd} addTitle={t('Open another file with ONLYOFFICE', 'Mở file khác bằng ONLYOFFICE')}>
        {busy && <Loader2 size={15} className="of-spin of-dim" />}
        {legacy ? (
          <button
            className="of-tool"
            title={t(`The old .${file.path.split('.').pop()} format is view-only. Save a .${legacy} copy beside it to edit.`, `Định dạng cũ .${file.path.split('.').pop()} chỉ xem được. Lưu một bản .${legacy} cạnh nó để sửa.`)}
            disabled={busy || file.state !== 'ready'}
            onClick={() => convert(file.path, legacy)}
          >
            <FileOutput size={15} /> {t(`Save as .${legacy} to edit`, `Lưu thành .${legacy} để sửa`)}
          </button>
        ) : (
          <SaveStatus dirty={file.dirty} s={auto.saveState[file.path]} note={note(t)} />
        )}
      </FileTabs>
      {error && (
        <p className="of-error of-pad" onClick={() => setError('')} title={t('Click to hide', 'Bấm để ẩn')}>
          {error}
        </p>
      )}
      <div className="of-oo">
        {origin &&
          files.map((f) => (
            <iframe
              key={`${f.path}#${f.gen}`}
              ref={(el) => {
                if (el) frames.current.set(f.path, el)
              }}
              className={f.path === active ? 'on' : ''}
              src={`${origin}/editor.html?embed=1&locale=${f.locale}`}
              title={fileName(f.path)}
            />
          ))}
        {!origin ? (
          <div className="of-oo-state">
            {failed ? (
              <>
                <p className="of-error">{failed}</p>
                <button className="of-action" onClick={() => void ensureEditor()}>
                  <RefreshCw size={15} /> {t('Try again', 'Thử lại')}
                </button>
              </>
            ) : install && 'total' in install ? (
              <>
                <b>{t('Downloading ONLYOFFICE (first time only)', 'Đang tải ONLYOFFICE (chỉ lần đầu)')}</b>
                <progress max={install.total} value={install.done} />
                <p className="of-dim">
                  {Math.round(install.done / 1048576)} / {Math.round(install.total / 1048576)} MB. {t('After that, files open without the internet.', 'Sau đó mở file không cần mạng.')}
                </p>
              </>
            ) : (
              <Loader2 size={22} className="of-spin of-dim" />
            )}
          </div>
        ) : file.state === 'loading' ? (
          <div className="of-oo-state">
            <Loader2 size={22} className="of-spin of-dim" />
            <p className="of-dim">{t(`Opening ${fileName(file.path)}…`, `Đang mở ${fileName(file.path)}…`)}</p>
          </div>
        ) : (
          file.state === 'error' && (
            <div className="of-oo-state">
              <p className="of-error">{file.error}</p>
              <button className="of-action" onClick={() => patch(file.path, { state: 'loading', error: undefined, gen: file.gen + 1 })}>
                <RefreshCw size={15} /> {t('Reopen', 'Mở lại')}
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
})
