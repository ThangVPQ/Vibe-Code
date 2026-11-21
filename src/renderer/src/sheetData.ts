/**
 * FortuneSheet data helpers for the Office tab: CSV ↔ sheet, cell addresses, and the text Claude's
 * sheet_read gets. Pure functions (no React, no FortuneSheet import), so they run under plain Node too.
 */

/** the parts of FortuneSheet's Cell / Sheet these helpers touch */
export type FCell = { v?: string | number | boolean; m?: string | number; f?: string; ct?: { fa?: string; t?: string; s?: { v?: string }[] } } | null
export type FSheet = { name: string; id?: string; order?: number; status?: number; row?: number; column?: number; data?: FCell[][]; celldata?: { r: number; c: number; v: FCell }[] }

export function colName(c: number): string {
  let s = ''
  for (let n = c; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s
  return s
}

/** "B12" → { r: 11, c: 1 } */
export function parseCell(a: string): { r: number; c: number } {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(a.trim())
  if (!m || Number(m[2]) < 1) throw new Error(`ô không hợp lệ: ${a}`)
  const c = m[1].toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  return { r: Number(m[2]) - 1, c }
}

/** What a cell shows (its formatted value), "" when empty. */
export function cellText(cell: FCell | undefined): string {
  if (!cell) return ''
  if (cell.ct?.t === 'inlineStr' && cell.ct.s) return cell.ct.s.map((x) => x.v ?? '').join('')
  const v = cell.m ?? cell.v
  return v == null ? '' : String(v)
}

/** The sheet as a cell matrix: the live `data`, or one built from `celldata` (a file just loaded). */
export function matrix(sheet: FSheet): FCell[][] {
  if (sheet.data) return sheet.data
  const out: FCell[][] = []
  for (const { r, c, v } of sheet.celldata ?? []) {
    while (out.length <= r) out.push([])
    out[r][c] = v
  }
  return out
}

/**
 * A sheet to mount a workbook from: FortuneSheet builds its grid from `celldata` (the `data` matrix
 * that getAllSheets returns is ignored when mounting), so the matrix goes back into `celldata`.
 */
export function toCelldata<S extends FSheet>(sheet: S): S {
  if (!sheet.data) return sheet
  const celldata: { r: number; c: number; v: FCell }[] = []
  sheet.data.forEach((row, r) => row?.forEach((v, c) => v != null && celldata.push({ r, c, v })))
  const { data: _drop, ...rest } = sheet
  return { ...rest, celldata } as S
}

/** rows × columns that hold something */
export function usedSize(sheet: FSheet): { rows: number; cols: number } {
  const m = matrix(sheet)
  let rows = 0
  let cols = 0
  m.forEach((row, r) =>
    row?.forEach((cell, c) => {
      if (cellText(cell) !== '' || cell?.f) {
        rows = Math.max(rows, r + 1)
        cols = Math.max(cols, c + 1)
      }
    })
  )
  return { rows, cols }
}

/** Shown text of the used cells, for writing a .csv. */
export function sheetRows(sheet: FSheet): string[][] {
  const { rows, cols } = usedSize(sheet)
  const m = matrix(sheet)
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cellText(m[r]?.[c])))
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/

/** A .csv file's rows as a sheet: numbers stay numbers ("007" stays text), the rest is text. */
export function csvSheet(name: string, rows: string[][]): FSheet {
  const celldata: { r: number; c: number; v: FCell }[] = []
  rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === '') return
      celldata.push({ r, c, v: NUMBER.test(v) ? { v: Number(v), m: v, ct: { fa: 'General', t: 'n' } } : { v, m: v, ct: { fa: '@', t: 's' } } })
    })
  )
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0)
  return { name, order: 0, status: 1, celldata, row: Math.max(100, rows.length + 50), column: Math.max(26, cols + 10) }
}

/** Claude's sheet_read: tab-separated rows starting with their row number, under a line of column letters. */
export function readText(sheet: FSheet, range?: string): string {
  const m = matrix(sheet)
  const used = usedSize(sheet)
  let r0 = 0
  let c0 = 0
  let r1 = Math.min(199, used.rows - 1)
  let c1 = used.cols - 1
  if (range) {
    const [a, b = a] = range.split(':')
    ;({ r: r0, c: c0 } = parseCell(a))
    ;({ r: r1, c: c1 } = parseCell(b))
  }
  r1 = Math.min(r1, used.rows - 1, r0 + 999)
  c1 = Math.min(c1, used.cols - 1)
  if (r0 > r1 || c0 > c1) return `Sheet "${sheet.name}": no cells in that range (the sheet uses ${used.rows} rows × ${used.cols} columns).`
  const lines = [`Sheet "${sheet.name}" (${used.rows} rows × ${used.cols} columns used)`, ['#', ...Array.from({ length: c1 - c0 + 1 }, (_, i) => colName(c0 + i))].join('\t')]
  for (let r = r0; r <= r1; r++) {
    const cells = [String(r + 1)]
    for (let c = c0; c <= c1; c++) {
      const cell = m[r]?.[c]
      const text = cellText(cell).replace(/[\t\r\n]+/g, ' ')
      cells.push(cell?.f ? `${text} [${cell.f.startsWith('=') ? '' : '='}${cell.f}]` : text)
    }
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}
