import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Bot,
  Eraser,
  FileText,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Minus,
  Plus,
  Redo2,
  Save,
  Strikethrough,
  Table2,
  Underline,
  Undo2
} from 'lucide-react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyleKit } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import type { OfficeRequest } from '../../../shared/types'
import { newChatFromOfficeFile } from '../actions'
import { docxToHtml, htmlText, htmlToDocx } from '../docxHtml'
import { openMenu } from './ContextMenu'
import { FileTabs, SaveStatus, type Workspace, type WorkspaceProps, errText, fileName, findOpen, samePath, toBase64, useAutosave } from './officeShared'

const DOC_NOTE = 'Lưu thành .docx giữ chữ, tiêu đề, định dạng chữ, màu, danh sách, bảng, ảnh, link; không giữ header/footer, section, text box.'
const FONTS = ['Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Tahoma', 'Verdana', 'Courier New']
const SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72]
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

type OpenFile = { path: string; html: string; dirty: boolean }

async function writeDoc(path: string, html: string): Promise<void> {
  const blob = await htmlToDocx(html)
  await window.api.office.writeFile(path, toBase64(await blob.arrayBuffer()))
}

/** data: image sources ↔ short "image:N" names, so Claude reads and writes the text without the pixels */
function hideImages(html: string): { html: string; images: string[] } {
  const images: string[] = []
  return { html: html.replace(/src="(data:[^"]+)"/g, (_, src: string) => `src="image:${images.push(src)}"`), images }
}
const showImages = (html: string, images: string[]): string => html.replace(/src="image:(\d+)"/g, (m, n: string) => (images[Number(n) - 1] ? `src="${images[Number(n) - 1]}"` : m))

/* ================================ workspace ================================ */

/** Office tab → Docs: .docx files, one file tab each, in a Word-like page editor. */
export const DocsWorkspace = forwardRef<Workspace, WorkspaceProps>(function DocsWorkspace({ shown, onFiles, onAdd }, ref) {
  const [files, setFiles] = useState<OpenFile[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(1)
  const filesRef = useRef(files)
  filesRef.current = files
  const activeRef = useRef(active)
  activeRef.current = active
  /** each file's current HTML (the one on screen: the editor's) */
  const live = useRef(new Map<string, string>())
  /** content set by the app (switching files), not an edit */
  const quiet = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TextStyleKit,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({ allowBase64: true }),
      Highlight.configure({ multicolor: true })
    ],
    content: '',
    onUpdate: ({ editor: e }) => {
      const path = activeRef.current
      if (quiet.current || !path) return
      live.current.set(path, e.getHTML())
      auto.changed(path)
    }
  })

  const file = files.find((f) => f.path === active) ?? null
  useEffect(() => onFiles(files.map((f) => f.path)), [files.length])

  const htmlOf = (path: string): string =>
    path === activeRef.current && editor ? editor.getHTML() : (live.current.get(path) ?? filesRef.current.find((f) => f.path === path)?.html ?? '')
  const setDirty = (path: string, dirty: boolean): void =>
    setFiles((fs) => (fs.some((f) => f.path === path && f.dirty !== dirty) ? fs.map((f) => (f.path === path ? { ...f, dirty } : f)) : fs))
  const auto = useAutosave({ isOpen: (p) => filesRef.current.some((f) => f.path === p), setDirty, write: (p) => writeDoc(p, htmlOf(p)) })

  /** puts a file in the editor */
  const show = (path: string): void => {
    const cur = activeRef.current
    if (cur === path || !editor) return
    if (cur) {
      const html = editor.getHTML()
      live.current.set(cur, html)
      if (auto.pending(cur)) void auto.saveNow(cur, () => writeDoc(cur, html)).catch(() => {})
    }
    activeRef.current = path
    setActive(path)
    quiet.current = true
    editor.commands.setContent(live.current.get(path) ?? filesRef.current.find((f) => f.path === path)?.html ?? '<p></p>', { emitUpdate: false })
    quiet.current = false
    scrollRef.current?.scrollTo({ top: 0 })
  }

  const openPath = async (path: string, create = false): Promise<void> => {
    const open = filesRef.current.find((f) => samePath(f.path, path))
    if (open) return show(open.path)
    const html = create ? '<p></p>' : await docxToHtml(await window.api.office.readFile(path))
    if (create) {
      await writeDoc(path, html)
      auto.created(path)
    }
    live.current.set(path, html)
    filesRef.current = [...filesRef.current, { path, html, dirty: false }]
    setFiles(filesRef.current)
    show(path)
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
      if (activeRef.current === path && editor) live.current.set(path, editor.getHTML())
      auto.forget(path)
      const i = filesRef.current.findIndex((x) => x.path === path)
      const rest = filesRef.current.filter((x) => x.path !== path)
      filesRef.current = rest
      setFiles(rest)
      live.current.delete(path)
      if (activeRef.current === path) {
        activeRef.current = null
        const next = rest[Math.min(i, rest.length - 1)]?.path
        if (next) show(next)
        else setActive(null)
      }
    }
    if (!f.dirty) return drop()
    run(async () => {
      try {
        await auto.saveNow(path)
      } catch (err) {
        if (!window.confirm(`Không lưu được "${fileName(path)}":\n${errText(err)}\n\nVẫn đóng và bỏ các thay đổi chưa lưu?`)) return
      }
      drop()
    })
  }

  /* ---------- Claude's tools ---------- */
  const status = (f: OpenFile): string => {
    const text = htmlText(htmlOf(f.path))
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    return `${f.path === activeRef.current ? '[on screen] ' : ''}${f.path}${f.dirty ? ' (unsaved changes)' : ''}\n- document: ${words} words`
  }
  const tool = async (req: OfficeRequest): Promise<string> => {
    const a = req.args
    const f = findOpen(filesRef.current, activeRef.current, a.file, 'document')
    switch (req.tool) {
      case 'doc_read':
        return hideImages(htmlOf(f.path)).html
      case 'doc_write': {
        if (typeof a.html !== 'string') throw new Error('missing `html`')
        if (!editor) throw new Error('the editor is not ready')
        show(f.path)
        const html = showImages(a.html, hideImages(htmlOf(f.path)).images)
        if (a.mode === 'replace') editor.commands.setContent(html, { emitUpdate: true })
        else editor.commands.insertContentAt(editor.state.doc.content.size, html)
        live.current.set(f.path, editor.getHTML())
        auto.changed(f.path)
        return `${a.mode === 'replace' ? 'Replaced the content of' : 'Appended to'} ${fileName(f.path)}. The file saves itself about a second later.`
      }
    }
    throw new Error(`unknown tool ${String(req.tool)}`)
  }
  useImperativeHandle(ref, () => ({ open: openPath, tool, status: () => filesRef.current.map(status) }))

  // Ctrl + wheel zooms the page
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom((z) => (e.deltaY < 0 ? (ZOOMS.find((s) => s > z + 0.001) ?? z) : ([...ZOOMS].reverse().find((s) => s < z - 0.001) ?? z)))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [file !== null])

  if (!file || !editor) return null
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
      <FileTabs files={files} active={active} icon={<FileText size={13} className="of-ic-doc" />} onShow={show} onClose={close} onAdd={onAdd} addTitle="Mở tài liệu khác / tạo mới">
        {busy && <Loader2 size={15} className="of-spin of-dim" />}
        <SaveStatus dirty={file.dirty} s={auto.saveState[file.path]} note={DOC_NOTE} />
        <button className="of-tool" title={`Lưu (Ctrl+S). ${DOC_NOTE}`} disabled={!file.dirty || busy} onClick={() => run(() => auto.saveNow(file.path))}>
          <Save size={15} /> Lưu
        </button>
        <button className="of-tool of-ai" title="Mở chat Claude làm việc với tài liệu này" onClick={() => void newChatFromOfficeFile(file.path)}>
          <Bot size={15} /> Giao cho AI
        </button>
      </FileTabs>
      {error && (
        <p className="of-error of-pad" onClick={() => setError('')} title="Bấm để ẩn">
          {error}
        </p>
      )}
      <DocToolbar editor={editor} zoom={zoom} onZoom={setZoom} onError={(e) => setError(errText(e))} />
      <div className="of-doc-scroll" ref={scrollRef}>
        <div className="of-page" style={{ zoom }}>
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  )
})

/* ================================ toolbar ================================ */

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' }

function DocToolbar({ editor, zoom, onZoom, onError }: { editor: Editor; zoom: number; onZoom: (z: number) => void; onError: (e: unknown) => void }): React.JSX.Element {
  // re-render on selection / formatting changes only for what the toolbar shows
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      align: (['center', 'right', 'justify'] as const).find((x) => e.isActive({ textAlign: x })) ?? 'left',
      font: (e.getAttributes('textStyle').fontFamily as string | undefined)?.replace(/["']/g, '') ?? '',
      size: (e.getAttributes('textStyle').fontSize as string | undefined)?.replace('pt', '') ?? '',
      color: (e.getAttributes('textStyle').color as string | undefined) ?? '#000000',
      canUndo: e.can().undo(),
      canRedo: e.can().redo()
    })
  })
  const [linkOpen, setLinkOpen] = useState(false)
  const [href, setHref] = useState('')
  const chain = () => editor.chain().focus()
  const btn = (title: string, icon: React.ReactNode, onClick: () => void, on = false, disabled = false): React.JSX.Element => (
    <button className={'of-tb' + (on ? ' on' : '')} title={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {icon}
    </button>
  )
  const addImage = async (): Promise<void> => {
    const [p] = await window.api.app.pickFiles()
    if (!p) return
    const mime = IMAGE_MIME[p.split('.').pop()?.toLowerCase() ?? '']
    if (!mime) throw new Error('Chỉ chèn được ảnh .png, .jpg, .gif, .bmp')
    const src = `data:${mime};base64,${toBase64(await window.api.office.readFile(p))}`
    chain().setImage({ src }).run()
  }
  return (
    <div className="of-doc-toolbar">
      {btn('Hoàn tác (Ctrl+Z)', <Undo2 size={15} />, () => chain().undo().run(), false, !s.canUndo)}
      {btn('Làm lại (Ctrl+Y)', <Redo2 size={15} />, () => chain().redo().run(), false, !s.canRedo)}
      <span className="of-tbsep" />
      <select
        className="of-tbselect"
        title="Kiểu đoạn"
        value={s.block}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'p') chain().setParagraph().run()
          else chain().setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run()
        }}
      >
        <option value="p">Văn bản</option>
        <option value="h1">Tiêu đề 1</option>
        <option value="h2">Tiêu đề 2</option>
        <option value="h3">Tiêu đề 3</option>
      </select>
      <select className="of-tbselect wide" title="Font chữ" value={s.font} onChange={(e) => (e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run())}>
        <option value="">Font mặc định</option>
        {[...new Set([...FONTS, ...(s.font ? [s.font] : [])])].map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <select className="of-tbselect" title="Cỡ chữ" value={s.size} onChange={(e) => (e.target.value ? chain().setFontSize(`${e.target.value}pt`).run() : chain().unsetFontSize().run())}>
        <option value="">Cỡ</option>
        {[...new Set([...SIZES.map(String), ...(s.size ? [s.size] : [])])].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <span className="of-tbsep" />
      {btn('Đậm (Ctrl+B)', <Bold size={15} />, () => chain().toggleBold().run(), s.bold)}
      {btn('Nghiêng (Ctrl+I)', <Italic size={15} />, () => chain().toggleItalic().run(), s.italic)}
      {btn('Gạch chân (Ctrl+U)', <Underline size={15} />, () => chain().toggleUnderline().run(), s.underline)}
      {btn('Gạch ngang', <Strikethrough size={15} />, () => chain().toggleStrike().run(), s.strike)}
      <label className="of-tb of-color" title="Màu chữ" onMouseDown={(e) => e.stopPropagation()}>
        <span style={{ borderBottomColor: s.color }}>A</span>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#000000'} onChange={(e) => chain().setColor(e.target.value).run()} />
      </label>
      <label className="of-tb of-color" title="Tô nền chữ">
        <Highlighter size={15} />
        <input type="color" defaultValue="#ffff00" onChange={(e) => chain().setHighlight({ color: e.target.value }).run()} />
      </label>
      <span className="of-tbsep" />
      {btn('Căn trái', <AlignLeft size={15} />, () => chain().setTextAlign('left').run(), s.align === 'left')}
      {btn('Căn giữa', <AlignCenter size={15} />, () => chain().setTextAlign('center').run(), s.align === 'center')}
      {btn('Căn phải', <AlignRight size={15} />, () => chain().setTextAlign('right').run(), s.align === 'right')}
      {btn('Căn đều hai bên', <AlignJustify size={15} />, () => chain().setTextAlign('justify').run(), s.align === 'justify')}
      <span className="of-tbsep" />
      {btn('Danh sách chấm', <List size={15} />, () => chain().toggleBulletList().run(), s.bullet)}
      {btn('Danh sách số', <ListOrdered size={15} />, () => chain().toggleOrderedList().run(), s.ordered)}
      {btn('Giảm thụt lề (Shift+Tab)', <IndentDecrease size={15} />, () => chain().liftListItem('listItem').run(), false, !(s.bullet || s.ordered))}
      {btn('Tăng thụt lề (Tab)', <IndentIncrease size={15} />, () => chain().sinkListItem('listItem').run(), false, !(s.bullet || s.ordered))}
      <span className="of-tbsep" />
      <button
        className={'of-tb of-tbmenu' + (s.table ? ' on' : '')}
        title="Bảng"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) =>
          openMenu(e, [
            { label: 'Chèn bảng 3 × 3', action: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run() },
            'sep',
            { label: 'Thêm hàng phía trên', disabled: !s.table, action: () => chain().addRowBefore().run() },
            { label: 'Thêm hàng phía dưới', disabled: !s.table, action: () => chain().addRowAfter().run() },
            { label: 'Thêm cột bên trái', disabled: !s.table, action: () => chain().addColumnBefore().run() },
            { label: 'Thêm cột bên phải', disabled: !s.table, action: () => chain().addColumnAfter().run() },
            'sep',
            { label: 'Xoá hàng', disabled: !s.table, action: () => chain().deleteRow().run() },
            { label: 'Xoá cột', disabled: !s.table, action: () => chain().deleteColumn().run() },
            { label: 'Gộp ô', disabled: !s.table, action: () => chain().mergeCells().run() },
            { label: 'Tách ô', disabled: !s.table, action: () => chain().splitCell().run() },
            { label: 'Xoá bảng', disabled: !s.table, action: () => chain().deleteTable().run() }
          ])
        }
      >
        <Table2 size={15} /> ▾
      </button>
      {btn('Chèn ảnh', <ImagePlus size={15} />, () => void addImage().catch(onError))}
      {btn(s.link ? 'Bỏ link' : 'Chèn link', <Link2 size={15} />, () => (s.link ? chain().unsetLink().run() : setLinkOpen((o) => !o)), s.link)}
      {linkOpen && (
        <form
          className="of-linkform"
          onSubmit={(e) => {
            e.preventDefault()
            if (href.trim()) chain().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(href.trim()) ? href.trim() : `https://${href.trim()}` }).run()
            setLinkOpen(false)
            setHref('')
          }}
        >
          <input autoFocus placeholder="https://…" value={href} onChange={(e) => setHref(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setLinkOpen(false)} />
        </form>
      )}
      {btn('Xoá định dạng', <Eraser size={15} />, () => chain().unsetAllMarks().clearNodes().run())}
      <span className="of-fill" />
      {btn('Thu nhỏ (Ctrl + lăn chuột)', <Minus size={14} />, () => onZoom([...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? zoom), false, zoom <= ZOOMS[0])}
      <button className="of-tb of-zoompct" title="Về 100%" onClick={() => onZoom(1)}>
        {Math.round(zoom * 100)}%
      </button>
      {btn('Phóng to (Ctrl + lăn chuột)', <Plus size={14} />, () => onZoom(ZOOMS.find((z) => z > zoom + 0.001) ?? zoom), false, zoom >= ZOOMS[ZOOMS.length - 1])}
    </div>
  )
}
