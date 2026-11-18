import { app, safeStorage } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { basename, dirname, join, relative } from 'path'
import { BRIDGE_PS1 } from './mssqlBridge.ps1'
import type { DbConnection, DbConnectionInput, DbFound, DbObject, DbColumn, DbQueryResult } from '../shared/types'

/* ======================= the bridge process (PowerShell + SqlClient) ======================= */

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
}

let proc: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let seq = 0
const pending = new Map<number, Pending>()

/** Keep stdin plain ASCII: the bridge reads it with the console code page. */
const ascii = (s: string): string => s.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

function start(): Promise<void> {
  if (ready && proc && proc.exitCode === null) return ready
  const dir = join(app.getPath('userData'), 'mssql')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'bridge.ps1')
  writeFileSync(script, BRIDGE_PS1)
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true
  })
  proc = p
  let buf = ''
  let stderr = ''
  ready = new Promise<void>((resolve, reject) => {
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.ready) {
          resolve()
          continue
        }
        const w = pending.get(msg.id as number)
        if (w) {
          pending.delete(msg.id as number)
          w.resolve(msg)
        }
      }
    })
    p.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-4000)))
    p.on('exit', () => {
      if (proc === p) {
        proc = null
        ready = null
      }
      const err = new Error(stderr.trim() ? `SQL runner stopped: ${stderr.trim().split('\n')[0]}` : 'Query stopped.')
      for (const w of pending.values()) w.reject(err)
      pending.clear()
      reject(err)
    })
    p.on('error', (e) => reject(e))
  })
  return ready
}

async function bridge(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  await start()
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc!.stdin.write(ascii(JSON.stringify({ ...req, id })) + '\n')
  })
}

/** Stop whatever is running (the runner restarts on the next query). */
export function cancelQueries(): void {
  proc?.kill()
}

/* ======================= saved connections ======================= */

interface Stored {
  id: string
  name: string
  /** connection string, safeStorage-encrypted (base64) when available */
  conn: string
  enc: boolean
  claudeReadOnly: boolean
  color?: string
}

const storeFile = (): string => join(app.getPath('userData'), 'db-connections.json')

function load(): Stored[] {
  try {
    return JSON.parse(readFileSync(storeFile(), 'utf8')) as Stored[]
  } catch {
    return []
  }
}

function persist(list: Stored[]): void {
  writeFileSync(storeFile(), JSON.stringify(list, null, 2))
}

const seal = (conn: string): { conn: string; enc: boolean } =>
  safeStorage.isEncryptionAvailable()
    ? { conn: safeStorage.encryptString(conn).toString('base64'), enc: true }
    : { conn, enc: false }

const unseal = (s: Stored): string => (s.enc ? safeStorage.decryptString(Buffer.from(s.conn, 'base64')) : s.conn)

/** Connection string → key/value pairs (keys lower-cased), honouring "quoted" and 'quoted' values. */
export function parseConn(conn: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < conn.length) {
    const eq = conn.indexOf('=', i)
    if (eq < 0) break
    const key = conn.slice(i, eq).trim().toLowerCase()
    let j = eq + 1
    while (conn[j] === ' ') j++
    let val = ''
    const q = conn[j]
    if (q === '"' || q === "'") {
      j++
      while (j < conn.length) {
        if (conn[j] === q) {
          if (conn[j + 1] === q) {
            val += q
            j += 2
            continue
          }
          j++
          break
        }
        val += conn[j++]
      }
      const semi = conn.indexOf(';', j)
      i = semi < 0 ? conn.length : semi + 1
    } else {
      const semi = conn.indexOf(';', j)
      val = conn.slice(j, semi < 0 ? conn.length : semi).trim()
      i = semi < 0 ? conn.length : semi + 1
    }
    if (key) out[key] = val
  }
  return out
}

const pick = (kv: Record<string, string>, ...keys: string[]): string => {
  for (const k of keys) if (kv[k] !== undefined) return kv[k]
  return ''
}

/** A value safe inside a connection string. */
const quoteVal = (v: string): string => (/[;'"=]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function buildConn(f: { server: string; database?: string; windowsAuth: boolean; user?: string; password?: string; trustCert?: boolean; encrypt?: boolean }): string {
  const parts = [`Server=${quoteVal(f.server)}`]
  if (f.database) parts.push(`Database=${quoteVal(f.database)}`)
  if (f.windowsAuth) parts.push('Integrated Security=True')
  else parts.push(`User ID=${quoteVal(f.user ?? '')}`, `Password=${quoteVal(f.password ?? '')}`)
  if (f.encrypt) parts.push('Encrypt=True')
  if (f.trustCert !== false) parts.push('TrustServerCertificate=True')
  return parts.join(';')
}

function describe(s: Stored): DbConnection {
  let kv: Record<string, string> = {}
  try {
    kv = parseConn(unseal(s))
  } catch {
    /* unreadable (encrypted on another account) */
  }
  const integrated = /^(true|yes|sspi)$/i.test(pick(kv, 'integrated security', 'trusted_connection'))
  return {
    id: s.id,
    name: s.name,
    server: pick(kv, 'server', 'data source', 'address', 'addr', 'network address'),
    database: pick(kv, 'database', 'initial catalog'),
    auth: integrated ? 'windows' : 'sql',
    user: integrated ? '' : pick(kv, 'user id', 'uid', 'user'),
    claudeReadOnly: s.claudeReadOnly,
    color: s.color
  }
}

export function listConnections(): DbConnection[] {
  return load().map(describe)
}

export function getConnection(id: string): (DbConnection & { conn: string }) | null {
  const s = load().find((c) => c.id === id)
  return s ? { ...describe(s), conn: unseal(s) } : null
}

export function saveConnection(input: DbConnectionInput): DbConnection[] {
  const list = load()
  const i = input.id ? list.findIndex((c) => c.id === input.id) : -1
  const item: Stored = {
    id: i >= 0 ? list[i].id : randomBytes(6).toString('hex'),
    name: input.name.trim() || 'SQL Server',
    ...seal(input.conn),
    claudeReadOnly: input.claudeReadOnly,
    color: input.color
  }
  if (i >= 0) list[i] = item
  else list.push(item)
  persist(list)
  return list.map(describe)
}

export function saveConnections(inputs: DbConnectionInput[]): DbConnection[] {
  let out = listConnections()
  for (const c of inputs) out = saveConnection(c)
  return out
}

export function removeConnection(id: string): DbConnection[] {
  const list = load().filter((c) => c.id !== id)
  persist(list)
  return list.map(describe)
}

/** By id or by name (case-insensitive) — Claude refers to connections by name. */
function findStored(ref: string): Stored {
  const list = load()
  const s = list.find((c) => c.id === ref) ?? list.find((c) => c.name.toLowerCase() === ref.trim().toLowerCase())
  if (!s) throw new Error(`No saved connection "${ref}". Saved: ${list.map((c) => c.name).join(', ') || '(none)'}`)
  return s
}

/* ======================= queries ======================= */

/** T-SQL batches split on GO lines (GO isn't SQL — SSMS / sqlcmd split on it, so do we). */
function batches(sql: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  const lines = sql.split(/\r?\n/)
  let cur: string[] = []
  let startLine = 1
  lines.forEach((l, i) => {
    if (/^\s*go\s*(--.*)?$/i.test(l)) {
      if (cur.join('\n').trim()) out.push({ text: cur.join('\n'), line: startLine })
      cur = []
      startLine = i + 2
    } else cur.push(l)
  })
  if (cur.join('\n').trim()) out.push({ text: cur.join('\n'), line: startLine })
  return out
}

const bracket = (name: string): string => `[${name.replace(/]/g, ']]')}]`

async function runOn(conn: string, sql: string, opts: { database?: string; maxRows?: number; timeout?: number; readOnly?: boolean }): Promise<DbQueryResult> {
  const t0 = Date.now()
  const result: DbQueryResult = { ok: true, results: [], messages: [], affected: -1, ms: 0 }
  for (const b of batches(sql)) {
    // USE on the same line, so the server's line numbers still match the editor's
    const text = (opts.database ? `USE ${bracket(opts.database)}; ` : '') + b.text
    const r = (await bridge({ conn, sql: text, maxRows: opts.maxRows ?? 1000, timeout: opts.timeout ?? 120, readOnly: !!opts.readOnly })) as unknown as DbQueryResult
    result.results.push(...(r.results ?? []))
    // (our own USE says "Changed database context to …" — not news to the user)
    result.messages.push(...(r.messages ?? []).filter((m) => !(opts.database && /^Changed database context to /.test(m))))
    if (r.affected >= 0) result.affected = Math.max(0, result.affected) + r.affected
    if (!r.ok) {
      result.ok = false
      // server line numbers are per batch: shift them to the editor's
      result.error = (r.error ?? 'Query failed').replace(/^Line (\d+):/gm, (_m, n) => `Line ${Number(n) + b.line - 1}:`)
      break
    }
  }
  result.ms = Date.now() - t0
  return result
}

export function query(id: string, sql: string, database?: string, maxRows?: number): Promise<DbQueryResult> {
  return runOn(unseal(findStored(id)), sql, { database, maxRows })
}

export async function testConnection(conn: string): Promise<{ ok: boolean; error?: string; version?: string }> {
  const r = await runOn(conn, "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) + ' ' + CAST(SERVERPROPERTY('Edition') AS nvarchar(128)), DB_NAME()", { timeout: 20 })
  if (!r.ok) return { ok: false, error: r.error }
  const row = r.results[0]?.rows[0] ?? []
  return { ok: true, version: `SQL Server ${row[0]} · database ${row[1]}` }
}

export async function listDatabases(id: string): Promise<string[]> {
  const r = await query(id, 'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name', undefined, 5000)
  if (!r.ok) throw new Error(r.error)
  return r.results[0].rows.map((x) => String(x[0]))
}

export async function listObjects(id: string, database: string): Promise<DbObject[]> {
  const r = await query(
    id,
    `SELECT s.name, o.name, o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE o.type IN ('U','V','P','FN','IF','TF') AND o.is_ms_shipped = 0 ORDER BY o.type, s.name, o.name`,
    database,
    20000
  )
  if (!r.ok) throw new Error(r.error)
  return r.results[0].rows.map((x) => ({ schema: String(x[0]), name: String(x[1]), type: String(x[2]).trim() as DbObject['type'] }))
}

const COLUMNS_SQL = (schema: string, table: string): string => `
SELECT c.name, TYPE_NAME(c.user_type_id)
  + CASE WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar) END + ')'
         WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar) END + ')'
         WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar) + ',' + CAST(c.scale AS varchar) + ')'
         ELSE '' END,
  c.is_nullable, c.is_identity,
  CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                    WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END,
  (SELECT OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) + '.' + COL_NAME(fk.referenced_object_id, fk.referenced_column_id)
     FROM sys.foreign_key_columns fk WHERE fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id)
FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'${bracket(schema).replace(/'/g, "''")}.${bracket(table).replace(/'/g, "''")}')
ORDER BY c.column_id`

export async function listColumns(id: string, database: string, schema: string, table: string): Promise<DbColumn[]> {
  const r = await query(id, COLUMNS_SQL(schema, table), database, 5000)
  if (!r.ok) throw new Error(r.error)
  return r.results[0].rows.map((x) => ({
    name: String(x[0]),
    type: String(x[1]),
    nullable: !!x[2],
    identity: !!x[3],
    pk: !!x[4],
    ref: x[5] ? String(x[5]) : undefined
  }))
}

/* ======================= finding existing connections ======================= */

const looksSql = (s: string): boolean =>
  /(^|;)\s*(server|data source|address|addr)\s*=/i.test(s) &&
  /(initial catalog|database|integrated security|trusted_connection|user id|uid)\s*=/i.test(s) &&
  !/(^|;)\s*(host|port)\s*=/i.test(s)

/** SQL Server connection strings in a project: appsettings*.json, *.config, .env files. */
export async function scanProject(folder: string): Promise<DbFound[]> {
  const out: DbFound[] = []
  const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'out', '.vs', '.idea', 'packages', 'wwwroot'])
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5 || out.length > 200) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(p, depth + 1)
        continue
      }
      const n = e.name.toLowerCase()
      const json = /^(appsettings.*|connectionstrings|secrets|launchsettings)\.json$/.test(n)
      const xml = /\.config$/.test(n) && !/packages\.config$/.test(n)
      const env = /^\.env(\..*)?$/.test(n)
      if (!json && !xml && !env) continue
      let text: string
      try {
        text = await readFile(p, 'utf8')
      } catch {
        continue
      }
      const rel = relative(folder, p) || basename(p)
      const proj = basename(dirname(p))
      const add = (key: string, conn: string): void => {
        if (looksSql(conn) && !out.some((f) => f.conn === conn)) out.push({ name: `${proj} · ${key}`, conn, file: rel })
      }
      if (json) {
        try {
          const obj = JSON.parse(text.replace(/^﻿/, '').replace(/\/\*[\s\S]*?\*\/|(?<![:"\w])\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))
          const visit = (v: unknown, key: string): void => {
            if (typeof v === 'string') add(key, v)
            else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k)
          }
          visit(obj, 'connection')
        } catch {
          for (const m of text.matchAll(/"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) add(m[1], m[2].replace(/\\(.)/g, '$1'))
        }
      } else if (xml) {
        for (const m of text.matchAll(/<add\b[^>]*>/gi)) {
          const name = /name\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? 'connection'
          const cs = /connectionString\s*=\s*"([^"]*)"/i.exec(m[0])?.[1]
          if (cs) add(name, cs.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
        }
      } else {
        for (const m of text.matchAll(/^\s*([\w.]+)\s*=\s*(.+)$/gm)) add(m[1], m[2].trim().replace(/^(["'])(.*)\1$/, '$2'))
      }
    }
  }
  if (folder && existsSync(folder)) await walk(folder, 0)
  return out
}

/** Connections saved in SQL Server Management Studio (passwords from Windows Credential Manager). */
export async function scanSsms(): Promise<DbFound[]> {
  const r = (await bridge({ op: 'ssms' })) as { connections?: Record<string, unknown>[] }
  const out: DbFound[] = []
  for (const c of r.connections ?? []) {
    const auth = String(c.auth ?? '')
    // 0 = Windows, 1 = SQL login; Entra ID kinds need a newer driver than Windows ships
    if (auth !== '0' && auth !== '1') continue
    const server = String(c.server)
    const user = String(c.user ?? '')
    const hasPwd = typeof c.password === 'string' && c.password !== ''
    out.push({
      name: auth === '0' ? server : `${server} (${user})`,
      conn: buildConn({
        server,
        database: String(c.database ?? ''),
        windowsAuth: auth === '0',
        user,
        password: hasPwd ? String(c.password) : '',
        trustCert: c.trustCert !== false,
        encrypt: c.encrypt === true
      }),
      file: String(c.source ?? 'SSMS'),
      needsPassword: auth === '1' && !hasPwd
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/* ======================= for Claude (MCP tools) ======================= */

const CELL_MAX = 300

function asTable(r: DbQueryResult['results'][number]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL'
    let s = typeof v === 'string' ? v : JSON.stringify(v)
    if (s.length > CELL_MAX) s = s.slice(0, CELL_MAX) + '…'
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '⏎')
  }
  const head = '| ' + r.columns.map((c) => esc(c.name || '(no name)')).join(' | ') + ' |'
  const sep = '|' + r.columns.map(() => '---').join('|') + '|'
  const rows = r.rows.map((row) => '| ' + row.map(esc).join(' | ') + ' |')
  return [head, sep, ...rows].join('\n') + `\n(${r.rows.length} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ', more rows not shown — narrow the query or raise max_rows' : ''})`
}

export const DB_TOOLS = [
  {
    name: 'mssql_connections',
    description: 'List the SQL Server connections the user saved in VIBE CODE (name, server, default database, auth, whether you may only read).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mssql_schema',
    description:
      'Explore a database. Without `table`: list databases (if no `database`), or tables/views/procedures in `database`. With `table` ("schema.name" or "name"): its columns with types, nullability, primary key and foreign keys.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name from mssql_connections' },
        database: { type: 'string' },
        table: { type: 'string' }
      },
      required: ['connection']
    }
  },
  {
    name: 'mssql_query',
    description:
      'Run T-SQL on a saved SQL Server connection and get the rows back as a table. Use T-SQL syntax (TOP, not LIMIT). GO separates batches. Connections marked read-only run inside a transaction that is always rolled back.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name from mssql_connections' },
        sql: { type: 'string' },
        database: { type: 'string', description: "Database to run in (default: the connection's own)" },
        max_rows: { type: 'number', description: 'Rows to return per result set (default 100, max 2000)' }
      },
      required: ['connection', 'sql']
    }
  }
]

export const DB_INSTRUCTIONS =
  "Query the SQL Server databases the user connected in VIBE CODE's Database tab. Start with mssql_connections, explore with mssql_schema, then mssql_query. Prefer small, targeted SELECTs (TOP n)."

/** Run one of the tools above; returns the text Claude sees. */
export async function callDbTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'mssql_connections') {
    const list = listConnections()
    if (!list.length) return 'No connections saved yet. Ask the user to add one in the Database tab of VIBE CODE.'
    return list
      .map((c) => `- ${c.name}: ${c.server}${c.database ? ` / ${c.database}` : ''} (${c.auth === 'windows' ? 'Windows auth' : `login ${c.user}`})${c.claudeReadOnly ? ' [read-only]' : ''}`)
      .join('\n')
  }
  const s = findStored(String(args.connection ?? ''))
  const conn = unseal(s)
  const database = args.database ? String(args.database) : undefined
  if (name === 'mssql_schema') {
    if (args.table) {
      const parts = String(args.table).replace(/[[\]]/g, '').split('.')
      const table = parts.pop()!
      const schema = parts.pop() || 'dbo'
      const r = await runOn(conn, COLUMNS_SQL(schema, table), { database, maxRows: 2000 })
      if (!r.ok) throw new Error(r.error)
      if (!r.results[0]?.rows.length) return `No table or view ${schema}.${table}${database ? ` in ${database}` : ''}.`
      return (
        `${schema}.${table}:\n` +
        r.results[0].rows
          .map((x) => `- ${x[0]} ${x[1]}${x[2] ? ' NULL' : ' NOT NULL'}${x[4] ? ' PK' : ''}${x[3] ? ' IDENTITY' : ''}${x[5] ? ` → ${x[5]}` : ''}`)
          .join('\n')
      )
    }
    if (!database) {
      const r = await runOn(conn, 'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name', { maxRows: 5000 })
      if (!r.ok) throw new Error(r.error)
      return 'Databases:\n' + r.results[0].rows.map((x) => `- ${x[0]}`).join('\n')
    }
    const r = await runOn(
      conn,
      `SELECT o.type_desc, s.name + '.' + o.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('U','V','P','FN','IF','TF') AND o.is_ms_shipped = 0 ORDER BY o.type, s.name, o.name`,
      { database, maxRows: 20000 }
    )
    if (!r.ok) throw new Error(r.error)
    const groups = new Map<string, string[]>()
    for (const [t, n] of r.results[0].rows) groups.set(String(t), [...(groups.get(String(t)) ?? []), String(n)])
    return [...groups].map(([t, ns]) => `${t} (${ns.length}):\n${ns.join(', ')}`).join('\n\n') || 'No user objects.'
  }
  if (name === 'mssql_query') {
    const sql = String(args.sql ?? '')
    if (s.claudeReadOnly && /\b(commit|save\s+tran(saction)?)\b/i.test(sql))
      throw new Error('This connection is read-only for Claude: COMMIT / SAVE TRANSACTION are not allowed.')
    const max = Math.max(1, Math.min(2000, Number(args.max_rows) || 100))
    const r = await runOn(conn, sql, { database, maxRows: max, readOnly: s.claudeReadOnly })
    const parts: string[] = r.results.map(asTable)
    if (r.messages.length) parts.push('Messages:\n' + r.messages.join('\n'))
    if (r.affected >= 0) parts.push(`${r.affected} row(s) affected${s.claudeReadOnly ? ' (rolled back: read-only connection)' : ''}.`)
    if (!r.ok) parts.push('Error: ' + r.error)
    let text = parts.join('\n\n') || 'Done (no results).'
    if (text.length > 80000) text = text.slice(0, 80000) + '\n… (output cut — ask for fewer rows or columns)'
    return text
  }
  throw new Error(`Unknown tool ${name}`)
}
