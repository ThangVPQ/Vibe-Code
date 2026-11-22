/**
 * .docx ↔ HTML for the Office tab's Docs editor. Both directions handle the same things, so a file
 * goes through open → edit → save keeping them: paragraphs and headings, alignment, bold / italic /
 * underline / strike, text color, size, font and highlight, bullet and numbered lists (nested),
 * tables (with merged columns), images and links. Page headers/footers, sections, text boxes,
 * comments and tracked changes are not read (the Office tab keeps a backup of the original file).
 */
import JSZip from 'jszip'
import {
  AlignmentType,
  Document as DocxDocument,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ParagraphChild
} from 'docx'
import { tr } from './i18n'

/* ================================ .docx → HTML ================================ */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'

const kids = (el: Element | null | undefined, name: string): Element[] => (el ? Array.from(el.children).filter((c) => c.localName === name) : [])
const kid = (el: Element | null | undefined, name: string): Element | undefined => kids(el, name)[0]
const wval = (el: Element | undefined): string | null => el?.getAttributeNS(W, 'val') ?? el?.getAttribute('w:val') ?? null
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** a w:b / w:i style toggle: present and not switched off */
const on = (el: Element | undefined): boolean => !!el && !['0', 'false', 'off'].includes(wval(el) ?? '')

const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff'
}
const ALIGN: Record<string, string> = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }

type Ctx = {
  rels: Record<string, string>
  zip: JSZip
  /** numId → level → is it a bullet list */
  bullets: Record<string, Record<string, boolean>>
  /** styleId → heading level */
  headings: Record<string, number>
}

async function runHtml(r: Element, ctx: Ctx): Promise<string> {
  const pr = kid(r, 'rPr')
  let text = ''
  for (const c of Array.from(r.children)) {
    if (c.localName === 't') text += esc(c.textContent ?? '')
    else if (c.localName === 'tab') text += '&emsp;'
    else if (c.localName === 'br' || c.localName === 'cr') text += '<br>'
    else if (c.localName === 'drawing') text += await imageHtml(c, ctx)
  }
  if (!text) return ''
  const style: string[] = []
  const color = wval(kid(pr, 'color'))
  if (color && color !== 'auto' && /^[0-9a-f]{6}$/i.test(color)) style.push(`color: #${color.toLowerCase()}`)
  const sz = Number(wval(kid(pr, 'sz')))
  if (sz) style.push(`font-size: ${sz / 2}pt`)
  const font = kid(pr, 'rFonts')
  const face = font?.getAttributeNS(W, 'ascii') ?? font?.getAttributeNS(W, 'hAnsi')
  if (face) style.push(`font-family: ${face}`)
  if (style.length) text = `<span style="${esc(style.join('; '))}">${text}</span>`
  const hl = wval(kid(pr, 'highlight'))
  const shade = kid(pr, 'shd')?.getAttributeNS(W, 'fill')
  const bg = hl && HIGHLIGHTS[hl] ? HIGHLIGHTS[hl] : shade && /^[0-9a-f]{6}$/i.test(shade) ? `#${shade.toLowerCase()}` : null
  if (bg) text = `<mark data-color="${bg}" style="background-color: ${bg}">${text}</mark>`
  const u = kid(pr, 'u')
  if (on(kid(pr, 'strike')) || on(kid(pr, 'dstrike'))) text = `<s>${text}</s>`
  if (u && wval(u) !== 'none') text = `<u>${text}</u>`
  if (on(kid(pr, 'i'))) text = `<em>${text}</em>`
  if (on(kid(pr, 'b'))) text = `<strong>${text}</strong>`
  return text
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' }

async function imageHtml(drawing: Element, ctx: Ctx): Promise<string> {
  const blip = drawing.getElementsByTagNameNS(A, 'blip')[0]
  const id = blip?.getAttributeNS(R, 'embed')
  const target = id ? ctx.rels[id] : undefined
  if (!target) return ''
  const file = ctx.zip.file(`word/${target.replace(/^\/?word\//, '').replace(/^\//, '')}`)
  const mime = MIME[target.split('.').pop()?.toLowerCase() ?? '']
  if (!file || !mime) return ''
  const b64 = await file.async('base64')
  const extent = drawing.getElementsByTagNameNS(WP, 'extent')[0]
  const width = Math.round(Number(extent?.getAttribute('cx') ?? 0) / 9525)
  return `<img src="data:${mime};base64,${b64}"${width ? ` width="${width}"` : ''}>`
}

async function inlineHtml(p: Element, ctx: Ctx): Promise<string> {
  let out = ''
  for (const c of Array.from(p.children)) {
    if (c.localName === 'r') out += await runHtml(c, ctx)
    else if (c.localName === 'hyperlink') {
      const href = ctx.rels[c.getAttributeNS(R, 'id') ?? '']
      const inner = await inlineHtml(c, ctx)
      out += href ? `<a href="${esc(href)}">${inner}</a>` : inner
    } else if (['ins', 'smartTag', 'sdt', 'sdtContent', 'fldSimple'].includes(c.localName)) out += await inlineHtml(c.localName === 'sdt' ? (kid(c, 'sdtContent') ?? c) : c, ctx)
  }
  return out
}

type Block = { html: string; list?: { ordered: boolean; level: number; numId: string } }

async function paragraph(p: Element, ctx: Ctx): Promise<Block> {
  const pr = kid(p, 'pPr')
  const align = ALIGN[wval(kid(pr, 'jc')) ?? '']
  const attr = align ? ` style="text-align: ${align}"` : ''
  const inner = await inlineHtml(p, ctx)
  const num = kid(pr, 'numPr')
  const numId = wval(kid(num, 'numId'))
  if (num && numId && numId !== '0') {
    const level = Number(wval(kid(num, 'ilvl')) ?? 0)
    return { html: `<p${attr}>${inner}</p>`, list: { ordered: !ctx.bullets[numId]?.[String(level)], level, numId } }
  }
  const h = ctx.headings[wval(kid(pr, 'pStyle')) ?? '']
  if (h) return { html: `<h${h}${attr}>${inner}</h${h}>` }
  return { html: `<p${attr}>${inner}</p>` }
}

async function tableHtml(tbl: Element, ctx: Ctx): Promise<string> {
  let html = '<table><tbody>'
  for (const tr of kids(tbl, 'tr')) {
    html += '<tr>'
    for (const tc of kids(tr, 'tc')) {
      const pr = kid(tc, 'tcPr')
      const span = Number(wval(kid(pr, 'gridSpan')) ?? 1)
      html += `<td${span > 1 ? ` colspan="${span}"` : ''}>${await blocksHtml(tc, ctx)}</td>`
    }
    html += '</tr>'
  }
  return html + '</tbody></table>'
}

/** Body-level content: paragraphs (consecutive list items grouped into nested ul/ol) and tables. */
async function blocksHtml(parent: Element, ctx: Ctx): Promise<string> {
  const blocks: Block[] = []
  const walk = async (el: Element): Promise<void> => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'p') blocks.push(await paragraph(c, ctx))
      else if (c.localName === 'tbl') blocks.push({ html: await tableHtml(c, ctx) })
      else if (c.localName === 'sdt') await walk(kid(c, 'sdtContent') ?? c)
    }
  }
  await walk(parent)
  let html = ''
  /** open lists, outermost first */
  const open: { ordered: boolean }[] = []
  const close = (to: number): void => {
    while (open.length > to) html += `</li></${open.pop()!.ordered ? 'ol' : 'ul'}>`
  }
  for (const b of blocks) {
    if (!b.list) {
      close(0)
      html += b.html
      continue
    }
    const depth = b.list.level + 1
    close(depth) // leave deeper lists
    if (open.length === depth) {
      // a sibling item in the same list, or a list of the other kind at this level
      if (open[depth - 1].ordered === b.list.ordered) {
        html += `</li><li>${b.html}`
        continue
      }
      close(depth - 1)
    }
    // open lists down to this item's level (a nested list goes inside the open <li>)
    while (open.length < depth) {
      const ordered = open.length === depth - 1 ? b.list.ordered : false
      html += `<${ordered ? 'ol' : 'ul'}><li>`
      open.push({ ordered })
    }
    html += b.html
  }
  close(0)
  return html
}

const parseXml = (s: string): Document => new DOMParser().parseFromString(s, 'application/xml')

/** A .docx file as HTML for the editor. */
export async function docxToHtml(bytes: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const read = async (p: string): Promise<Document | null> => {
    const f = zip.file(p)
    return f ? parseXml(await f.async('string')) : null
  }
  const doc = await read('word/document.xml')
  if (!doc) throw new Error(tr('The file is not a Word document (.docx)', 'File không phải tài liệu Word (.docx)'))
  const rels: Record<string, string> = {}
  for (const r of Array.from((await read('word/_rels/document.xml.rels'))?.getElementsByTagName('Relationship') ?? [])) rels[r.getAttribute('Id') ?? ''] = r.getAttribute('Target') ?? ''
  // lists: numId → abstractNum → per level, bullet or not
  const bullets: Ctx['bullets'] = {}
  const numbering = await read('word/numbering.xml')
  if (numbering) {
    const abstract: Record<string, Record<string, boolean>> = {}
    for (const an of Array.from(numbering.getElementsByTagNameNS(W, 'abstractNum'))) {
      const levels: Record<string, boolean> = {}
      for (const lvl of kids(an, 'lvl')) levels[lvl.getAttributeNS(W, 'ilvl') ?? '0'] = wval(kid(lvl, 'numFmt')) === 'bullet'
      abstract[an.getAttributeNS(W, 'abstractNumId') ?? ''] = levels
    }
    for (const num of Array.from(numbering.getElementsByTagNameNS(W, 'num'))) bullets[num.getAttributeNS(W, 'numId') ?? ''] = abstract[wval(kid(num, 'abstractNumId')) ?? ''] ?? {}
  }
  // headings: by the style's name ("heading 1", "Title") so translated style ids still work
  const headings: Ctx['headings'] = {}
  const styles = await read('word/styles.xml')
  for (const st of Array.from(styles?.getElementsByTagNameNS(W, 'style') ?? [])) {
    const name = (wval(kid(st, 'name')) ?? '').toLowerCase()
    const m = /^heading\s*([1-6])$/.exec(name)
    const id = st.getAttributeNS(W, 'styleId') ?? ''
    if (m) headings[id] = Number(m[1])
    else if (name === 'title') headings[id] = 1
  }
  const body = doc.getElementsByTagNameNS(W, 'body')[0]
  const html = body ? await blocksHtml(body, { rels, zip, bullets, headings }) : ''
  return html || '<p></p>'
}

/* ================================ HTML → .docx ================================ */

type Marks = { bold?: boolean; italics?: boolean; underline?: boolean; strike?: boolean; color?: string; size?: number; font?: string; shade?: string; link?: string }

const hex = (c: string | undefined): string | undefined => {
  if (!c) return undefined
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim()) ?? /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c.trim())
  if (m && m.length === 2) return m[1].toUpperCase()
  if (m) return (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase()
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c.trim())
  return rgb ? rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase() : undefined
}

/** font-size as Word half-points: "12pt" → 24, "16px" → 24 */
function halfPoints(v: string | undefined): number | undefined {
  const m = /^([\d.]+)\s*(pt|px)?$/.exec(v?.trim() ?? '')
  if (!m) return undefined
  const pt = m[2] === 'px' ? Number(m[1]) * 0.75 : Number(m[1])
  return Math.round(pt * 2)
}

function marksOf(el: Element, base: Marks): Marks {
  const m = { ...base }
  const tag = el.tagName.toLowerCase()
  if (tag === 'strong' || tag === 'b') m.bold = true
  if (tag === 'em' || tag === 'i') m.italics = true
  if (tag === 'u') m.underline = true
  if (tag === 's' || tag === 'strike' || tag === 'del') m.strike = true
  if (tag === 'a') m.link = el.getAttribute('href') ?? undefined
  const st = (el as HTMLElement).style
  if (st) {
    if (st.color) m.color = hex(st.color) ?? m.color
    if (st.fontSize) m.size = halfPoints(st.fontSize) ?? m.size
    if (st.fontFamily) m.font = st.fontFamily.replace(/["']/g, '').split(',')[0].trim()
    if (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) m.bold = true
    if (st.fontStyle === 'italic') m.italics = true
    if (tag === 'mark' || st.backgroundColor) m.shade = hex(st.backgroundColor || el.getAttribute('data-color') || '#ffff00') ?? m.shade
  }
  if (tag === 'mark' && !m.shade) m.shade = hex(el.getAttribute('data-color') ?? '') ?? 'FFFF00'
  return m
}

function runOptions(text: string, m: Marks): IRunOptions {
  return {
    text,
    bold: m.bold,
    italics: m.italics,
    underline: m.underline ? {} : undefined,
    strike: m.strike,
    color: m.color ?? (m.link ? '0563C1' : undefined),
    size: m.size,
    font: m.font,
    shading: m.shade ? { type: 'clear', fill: m.shade, color: 'auto' } : undefined
  } as IRunOptions
}

async function imageSize(src: string, width?: number): Promise<{ width: number; height: number }> {
  const img = new Image()
  img.src = src
  await img.decode().catch(() => {})
  const nw = img.naturalWidth || 400
  const nh = img.naturalHeight || 300
  const w = Math.min(width || nw, 600)
  return { width: Math.round(w), height: Math.round((nh * w) / nw) }
}

const IMG_TYPE: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' }

async function imageRun(img: Element): Promise<ImageRun | null> {
  const src = img.getAttribute('src') ?? ''
  const m = /^data:([^;]+);base64,/.exec(src)
  const type = m && IMG_TYPE[m[1].toLowerCase()]
  if (!type) return null
  const width = Number(img.getAttribute('width')) || undefined
  return new ImageRun({ type, data: src, transformation: await imageSize(src, width) })
}

async function inlines(node: Node, m: Marks, out: ParagraphChild[]): Promise<void> {
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) {
      const t = c.textContent ?? ''
      if (!t) continue
      const run = new TextRun(runOptions(t.replace(/ /g, '\t'), m))
      out.push(m.link ? new ExternalHyperlink({ link: m.link, children: [run] }) : run)
    } else if (c instanceof Element) {
      const tag = c.tagName.toLowerCase()
      if (tag === 'br') out.push(new TextRun({ break: 1 }))
      else if (tag === 'img') {
        const r = await imageRun(c)
        if (r) out.push(r)
      } else await inlines(c, marksOf(c, m), out)
    }
  }
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
const ALIGN_OUT: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED, left: AlignmentType.LEFT }

type List = { reference: 'bullets' | 'numbers'; level: number; instance: number }

async function para(el: Element, opts: Partial<IParagraphOptions>, list?: List): Promise<Paragraph> {
  const children: ParagraphChild[] = []
  await inlines(el, marksOf(el, {}), children)
  const align = ALIGN_OUT[(el as HTMLElement).style?.textAlign ?? '']
  return new Paragraph({ ...opts, children, alignment: align, numbering: list ? { reference: list.reference, level: list.level, instance: list.instance } : undefined })
}

/** HTML blocks → docx paragraphs and tables. */
async function blocks(parent: Element, list?: List, counter = { n: 0 }): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = []
  for (const el of Array.from(parent.children)) {
    const tag = el.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) out.push(await para(el, { heading: HEADINGS[Number(tag[1]) - 1] }))
    else if (tag === 'p' || tag === 'div') out.push(await para(el, {}, list))
    else if (tag === 'blockquote') out.push(...(await blocks(el, list, counter)).map((b) => b))
    else if (tag === 'ul' || tag === 'ol') {
      const reference = tag === 'ol' ? 'numbers' : 'bullets'
      const level = list ? Math.min(list.level + 1, 8) : 0
      // every top-level numbered list counts from 1
      const instance = !list || list.reference !== reference ? ++counter.n : list.instance
      for (const li of Array.from(el.children)) {
        const item = { reference, level, instance } as List
        const inner = Array.from(li.children)
        // a list item holds paragraphs (each in the list) and maybe a nested list
        if (!inner.some((c) => /^(p|ul|ol|h[1-6]|div)$/i.test(c.tagName))) out.push(await para(li, {}, item))
        else out.push(...(await blocks(li, item, counter)))
      }
    } else if (tag === 'table') {
      const rows: TableRow[] = []
      for (const tr of Array.from(el.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr'))) {
        const cells: TableCell[] = []
        for (const td of Array.from(tr.children)) {
          const content = (await blocks(td, undefined, counter)).filter((b) => b instanceof Paragraph || b instanceof Table)
          if (!content.length) content.push(await para(td, {}))
          cells.push(new TableCell({ children: content, columnSpan: Number(td.getAttribute('colspan')) || undefined }))
        }
        if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: tr.parentElement?.tagName.toLowerCase() === 'thead' }))
      }
      if (rows.length) out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }))
    } else if (tag === 'img') {
      const r = await imageRun(el)
      if (r) out.push(new Paragraph({ children: [r] }))
    } else if (tag === 'hr') out.push(new Paragraph({ thematicBreak: true, children: [] }))
    else if (tag === 'pre') out.push(new Paragraph({ children: [new TextRun({ text: el.textContent ?? '', font: 'Consolas' })] }))
  }
  return out
}

const LEVELS = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (i: number) => string) =>
  Array.from({ length: 9 }, (_, i) => ({ level: i, format, text: text(i), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } }))

/** The editor's HTML as .docx bytes. */
export async function htmlToDocx(html: string): Promise<Blob> {
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
  const children = await blocks(root)
  const doc = new DocxDocument({
    styles: { default: { document: { run: { font: 'Times New Roman', size: 26 } } } },
    numbering: {
      config: [
        { reference: 'bullets', levels: LEVELS(LevelFormat.BULLET, (i) => ['•', '◦', '▪'][i % 3]) },
        { reference: 'numbers', levels: LEVELS(LevelFormat.DECIMAL, (i) => `%${i + 1}.`) }
      ]
    },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [] })] }]
  })
  return Packer.toBlob(doc)
}

/** Plain text of the editor's HTML (for status lines). */
export const htmlText = (html: string): string => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
