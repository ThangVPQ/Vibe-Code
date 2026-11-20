import { monaco } from './monaco'

/* IntelliSense for the Database tab's SQL editor, after SSMS:
 * - completion: T-SQL keywords, functions, data types, snippets, databases, schemas, tables, views,
 *   procedures, functions, synonyms, columns (`alias.` / `table.` / `schema.` / `db.schema.`),
 *   variables, CTEs, temp tables, table variables, derived tables, procedure parameters
 * - Quick Info on hover, Parameter Info (signature help) for functions and EXEC
 * - red squiggles under object names that don't exist ("Invalid object name")
 * The schema is read from the database the editor runs against (or the script's last USE) and
 * cached; Ctrl+Shift+R refreshes it, like SSMS's "Refresh Local Cache". */

const K = monaco.languages.CompletionItemKind
type Item = monaco.languages.CompletionItem

/* ======================= target + schema cache ======================= */

interface Target {
  /** uri of the Database tab's editor model: other .sql editors get none of this */
  model: string
  id: string
  /** '' = the connection's default database */
  database: string
}
let target: Target | null = null

interface Obj {
  schema: string
  name: string
  /** sys.objects type: U V P X PC FN FS IF TF FT SN */
  type: string
}
interface Param {
  name: string
  type: string
  output: boolean
}
interface Catalog {
  objects: Obj[]
  schemas: string[]
  /** `schema.name` (lower case) → parameters */
  params: Map<string, Param[]>
}
interface Col {
  name: string
  type: string
  nullable?: boolean
  pk?: boolean
  ref?: string
}

const cache = new Map<string, Promise<unknown>>()
function cached<T>(key: string, load: () => Promise<T>): Promise<T | null> {
  let p = cache.get(key) as Promise<T> | undefined
  if (!p) {
    const fresh = load()
    p = fresh
    cache.set(key, fresh)
    // a failed load (server down, no access) is tried again next time
    fresh.catch(() => cache.get(key) === fresh && cache.delete(key))
  }
  return p.catch(() => null)
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'
const bracket = (n: string): string => `[${n.replace(/]/g, ']]')}]`
const sqlLit = (s: string): string => s.replace(/'/g, "''")

async function meta(id: string, db: string, sql: string): Promise<{ columns: { name: string }[]; rows: unknown[][] }[]> {
  const r = await window.api.db.query(id, sql, db || undefined, 50000)
  if (!r.ok) throw new Error(r.error)
  return r.results
}

const TYPE_TEXT = (t: string): string => `TYPE_NAME(${t}.user_type_id)
  + CASE WHEN TYPE_NAME(${t}.user_type_id) IN ('varchar','char','varbinary','binary') THEN '(' + CASE WHEN ${t}.max_length = -1 THEN 'max' ELSE CAST(${t}.max_length AS varchar) END + ')'
         WHEN TYPE_NAME(${t}.user_type_id) IN ('nvarchar','nchar') THEN '(' + CASE WHEN ${t}.max_length = -1 THEN 'max' ELSE CAST(${t}.max_length / 2 AS varchar) END + ')'
         WHEN TYPE_NAME(${t}.user_type_id) IN ('decimal','numeric') THEN '(' + CAST(${t}.precision AS varchar) + ',' + CAST(${t}.scale AS varchar) + ')'
         ELSE '' END`

// result sets are told apart by their first column's name
const CATALOG_SQL = `SET NOCOUNT ON;
SELECT s.name AS obj_schema, o.name, RTRIM(o.type) FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
 WHERE o.type IN ('U','V','P','X','PC','FN','FS','IF','TF','FT','SN') AND s.name <> 'sys' ORDER BY s.name, o.name;
SELECT name AS schema_name FROM sys.schemas WHERE schema_id < 16384 AND name NOT IN ('guest','sys','INFORMATION_SCHEMA') ORDER BY name;
SELECT OBJECT_SCHEMA_NAME(p.object_id) AS par_schema, OBJECT_NAME(p.object_id), p.name, ${TYPE_TEXT('p')}, p.is_output
  FROM sys.parameters p JOIN sys.objects o ON o.object_id = p.object_id
 WHERE p.parameter_id > 0 AND SCHEMA_NAME(o.schema_id) <> 'sys' ORDER BY p.object_id, p.parameter_id;`

function catalogOf(id: string, db: string): Promise<Catalog | null> {
  return cached(`${id}/${db.toLowerCase()}/catalog`, async () => {
    const cat: Catalog = { objects: [], schemas: [], params: new Map() }
    for (const set of await meta(id, db, CATALOG_SQL)) {
      const head = set.columns[0]?.name
      for (const r of set.rows) {
        const s = String(r[0] ?? '')
        if (head === 'obj_schema') cat.objects.push({ schema: s, name: String(r[1]), type: String(r[2]).trim() })
        else if (head === 'schema_name') cat.schemas.push(s)
        else if (head === 'par_schema') {
          const k = `${s}.${String(r[1])}`.toLowerCase()
          if (!cat.params.has(k)) cat.params.set(k, [])
          cat.params.get(k)!.push({ name: String(r[2]), type: String(r[3]), output: truthy(r[4]) })
        }
      }
    }
    return cat
  })
}

function columnsOf(id: string, db: string, schema: string, table: string): Promise<Col[] | null> {
  const system = /^(sys|information_schema)$/i.test(schema)
  return cached(`${id}/${db.toLowerCase()}/cols/${schema}.${table}`.toLowerCase(), async () => {
    if (!system) return window.api.db.columns(id, db, schema, table)
    // system views keep their columns in sys.all_columns
    const [set] = await meta(
      id,
      db,
      `SELECT c.name, ${TYPE_TEXT('c')}, c.is_nullable FROM sys.all_columns c WHERE c.object_id = OBJECT_ID(N'${sqlLit(`${bracket(schema)}.${bracket(table)}`)}') ORDER BY c.column_id`
    )
    return (set?.rows ?? []).map((r) => ({ name: String(r[0]), type: String(r[1]), nullable: truthy(r[2]) }))
  })
}

const databasesOf = (id: string): Promise<string[] | null> => cached(`${id}//databases`, () => window.api.db.databases(id))

export function setSqlTarget(t: Target | null): void {
  target = t
  if (!t) return
  // warm the cache so the first suggestion doesn't wait for the server
  catalogOf(t.id, t.database)
  databasesOf(t.id)
  const model = monaco.editor.getModel(monaco.Uri.parse(t.model))
  if (model) watch(model)
}

/** Drop what was read of a connection's schema (after a refresh in the tree, or an edit). */
export function forgetSqlSchema(id: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}/`)) cache.delete(k)
  if (target?.id === id) setSqlTarget(target)
}

/** Ctrl+Shift+R: read the schema again (SSMS's "Refresh Local Cache"). */
export function refreshSqlSchema(): void {
  if (target) forgetSqlSchema(target.id)
}

/* ======================= T-SQL vocabulary ======================= */

const RESERVED_LIST =
  'ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY CASCADE CASE CHECK CHECKPOINT CLOSE ' +
  'CLUSTERED COALESCE COLLATE COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTAINSTABLE CONTINUE CONVERT CREATE CROSS CURRENT ' +
  'CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY DESC ' +
  'DISK DISTINCT DISTRIBUTED DOUBLE DROP DUMP ELSE END ERRLVL ESCAPE EXCEPT EXEC EXECUTE EXISTS EXIT EXTERNAL FETCH FILE ' +
  'FILLFACTOR FOR FOREIGN FREETEXT FREETEXTTABLE FROM FULL FUNCTION GOTO GRANT GROUP HAVING HOLDLOCK IDENTITY IDENTITY_INSERT ' +
  'IDENTITYCOL IF IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY KILL LEFT LIKE LINENO LOAD MERGE NATIONAL NOCHECK ' +
  'NONCLUSTERED NOT NULL NULLIF OF OFF OFFSETS ON OPEN OPENDATASOURCE OPENQUERY OPENROWSET OPENXML OPTION OR ORDER OUTER OVER ' +
  'PERCENT PIVOT PLAN PRECISION PRIMARY PRINT PROC PROCEDURE PUBLIC RAISERROR READ READTEXT RECONFIGURE REFERENCES ' +
  'REPLICATION RESTORE RESTRICT RETURN REVERT REVOKE RIGHT ROLLBACK ROWCOUNT ROWGUIDCOL RULE SAVE SCHEMA SECURITYAUDIT SELECT ' +
  'SEMANTICKEYPHRASETABLE SEMANTICSIMILARITYDETAILSTABLE SEMANTICSIMILARITYTABLE SESSION_USER SET SETUSER SHUTDOWN SOME ' +
  'STATISTICS SYSTEM_USER TABLE TABLESAMPLE TEXTSIZE THEN TO TOP TRAN TRANSACTION TRIGGER TRUNCATE TRY_CONVERT TSEQUAL UNION ' +
  'UNIQUE UNPIVOT UPDATE UPDATETEXT USE USER VALUES VARYING VIEW WAITFOR WHEN WHERE WHILE WITH WITHIN WRITETEXT'
const MORE_KEYWORDS =
  'APPLY OUTPUT INSERTED DELETED MATCHED USING TRY CATCH THROW ROWS RANGE OFFSET NEXT ONLY FIRST LAST ROW PARTITION PRECEDING ' +
  'FOLLOWING UNBOUNDED NOLOCK READUNCOMMITTED READPAST UPDLOCK ROWLOCK TABLOCK NOCOUNT XACT_ABORT ANSI_NULLS QUOTED_IDENTIFIER ' +
  'RETURNS INCLUDE GO TIES SEQUENCE SYNONYM TYPE LOGIN ROLE ENCRYPTION RECOMPILE SCHEMABINDING READONLY MAXDOP OPTIMIZE ' +
  'UNKNOWN ISOLATION LEVEL SNAPSHOT SERIALIZABLE COMMITTED UNCOMMITTED REPEATABLE LOCAL GLOBAL STATIC FORWARD_ONLY FAST_FORWARD ' +
  'READ_ONLY SCROLL DYNAMIC KEYSET INSTEAD AFTER ENABLE DISABLE REBUILD REORGANIZE NOWAIT ABSOLUTE RELATIVE PRIOR DATEFIRST ' +
  'LANGUAGE XML JSON PATH AUTO RAW ROOT ELEMENTS INCLUDE_NULL_VALUES WITHOUT_ARRAY_WRAPPER STRING_AGG CONCAT IIF'
const RESERVED = new Set(RESERVED_LIST.split(' '))
const KEYWORDS = [...new Set([...RESERVED_LIST.split(' '), ...MORE_KEYWORDS.split(' ')])].filter((k) => !['STRING_AGG', 'CONCAT', 'IIF', 'COALESCE', 'NULLIF', 'CONVERT', 'TRY_CONVERT'].includes(k))

const DATA_TYPES = (
  'bigint int smallint tinyint bit decimal numeric money smallmoney float real date datetime datetime2 datetimeoffset ' +
  'smalldatetime time char varchar nchar nvarchar text ntext binary varbinary image uniqueidentifier xml sql_variant ' +
  'rowversion timestamp hierarchyid geography geometry sysname json'
).split(' ')
const DATA_TYPE_SET = new Set(DATA_TYPES)

/** built-in functions: signature (`[x]` = optional) */
const BUILTIN_SIGS = `COUNT(expression)
COUNT_BIG(expression)
SUM(expression)
AVG(expression)
MIN(expression)
MAX(expression)
STDEV(expression)
VAR(expression)
APPROX_COUNT_DISTINCT(expression)
GROUPING(column_expression)
STRING_AGG(expression, separator)
ISNULL(check_expression, replacement_value)
COALESCE(expression1, expression2, [...n])
NULLIF(expression1, expression2)
IIF(boolean_expression, true_value, false_value)
CHOOSE(index, val_1, val_2, [...n])
CAST(expression AS data_type)
CONVERT(data_type, expression, [style])
TRY_CAST(expression AS data_type)
TRY_CONVERT(data_type, expression, [style])
PARSE(string_value AS data_type)
TRY_PARSE(string_value AS data_type)
GETDATE()
GETUTCDATE()
SYSDATETIME()
SYSUTCDATETIME()
SYSDATETIMEOFFSET()
DATEADD(datepart, number, date)
DATEDIFF(datepart, startdate, enddate)
DATEDIFF_BIG(datepart, startdate, enddate)
DATEPART(datepart, date)
DATENAME(datepart, date)
DATETRUNC(datepart, date)
DATEFROMPARTS(year, month, day)
DATETIMEFROMPARTS(year, month, day, hour, minute, seconds, milliseconds)
DATETIME2FROMPARTS(year, month, day, hour, minute, seconds, fractions, precision)
EOMONTH(start_date, [month_to_add])
SWITCHOFFSET(datetimeoffset_expression, timezoneoffset_expression)
TODATETIMEOFFSET(datetime_expression, timezoneoffset_expression)
YEAR(date)
MONTH(date)
DAY(date)
ISDATE(expression)
FORMAT(value, format, [culture])
LEN(string_expression)
DATALENGTH(expression)
LEFT(character_expression, integer_expression)
RIGHT(character_expression, integer_expression)
SUBSTRING(expression, start, length)
CHARINDEX(expressionToFind, expressionToSearch, [start_location])
PATINDEX('%pattern%', expression)
REPLACE(string_expression, string_pattern, string_replacement)
REPLICATE(string_expression, integer_expression)
REVERSE(string_expression)
STUFF(character_expression, start, length, replace_with_expression)
TRANSLATE(inputString, characters, translations)
LTRIM(character_expression)
RTRIM(character_expression)
TRIM(string)
UPPER(character_expression)
LOWER(character_expression)
CONCAT(string_value1, string_value2, [...n])
CONCAT_WS(separator, argument1, argument2, [...n])
SPACE(integer_expression)
STR(float_expression, [length], [decimal])
CHAR(integer_expression)
NCHAR(integer_expression)
ASCII(character_expression)
UNICODE(ncharacter_expression)
QUOTENAME(character_string, [quote_character])
STRING_ESCAPE(text, type)
STRING_SPLIT(string, separator, [enable_ordinal])
SOUNDEX(character_expression)
DIFFERENCE(character_expression, character_expression)
FORMATMESSAGE(msg_number_or_string, [param_value, ...n])
ABS(numeric_expression)
CEILING(numeric_expression)
FLOOR(numeric_expression)
ROUND(numeric_expression, length, [function])
POWER(float_expression, y)
SQRT(float_expression)
SQUARE(float_expression)
EXP(float_expression)
LOG(float_expression, [base])
LOG10(float_expression)
SIGN(numeric_expression)
RAND([seed])
PI()
GREATEST(expression1, [...n])
LEAST(expression1, [...n])
ISNUMERIC(expression)
ROW_NUMBER()
RANK()
DENSE_RANK()
NTILE(integer_expression)
LAG(scalar_expression, [offset], [default])
LEAD(scalar_expression, [offset], [default])
FIRST_VALUE(scalar_expression)
LAST_VALUE(scalar_expression)
CUME_DIST()
PERCENT_RANK()
PERCENTILE_CONT(numeric_literal)
PERCENTILE_DISC(numeric_literal)
NEWID()
NEWSEQUENTIALID()
SCOPE_IDENTITY()
IDENT_CURRENT(table_or_view)
OBJECT_ID(object_name, [object_type])
OBJECT_NAME(object_id, [database_id])
OBJECT_SCHEMA_NAME(object_id, [database_id])
OBJECT_DEFINITION(object_id)
OBJECTPROPERTY(id, property)
COL_NAME(table_id, column_id)
COL_LENGTH(table, column)
COLUMNPROPERTY(id, column, property)
TYPE_NAME(type_id)
SCHEMA_NAME([schema_id])
SCHEMA_ID([schema_name])
DB_NAME([database_id])
DB_ID([database_name])
USER_NAME([id])
SUSER_SNAME([server_user_sid])
HOST_NAME()
APP_NAME()
SERVERPROPERTY(propertyname)
DATABASEPROPERTYEX(database, property)
ERROR_MESSAGE()
ERROR_NUMBER()
ERROR_LINE()
ERROR_SEVERITY()
ERROR_STATE()
ERROR_PROCEDURE()
XACT_STATE()
HASHBYTES(algorithm, input)
CHECKSUM(expression, [...n])
BINARY_CHECKSUM(expression, [...n])
COMPRESS(expression)
DECOMPRESS(expression)
ISJSON(expression)
JSON_VALUE(expression, path)
JSON_QUERY(expression, [path])
JSON_MODIFY(expression, path, newValue)
JSON_OBJECT([key:value, ...n])
JSON_ARRAY([value, ...n])
OPENJSON(jsonExpression, [path])
GENERATE_SERIES(start, stop, [step])
OPENROWSET(provider, connection, query)
OPENQUERY(linked_server, query)
OPENXML(idoc, rowpattern, [flags])
CHANGETABLE(CHANGES table, last_sync_version)
CONTAINSTABLE(table, column, contains_search_condition)
FREETEXTTABLE(table, column, freetext_string)`
const BUILTINS = new Map<string, string[]>()
for (const line of BUILTIN_SIGS.split('\n')) {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(line.trim())
  if (m) BUILTINS.set(m[1], m[2] === undefined ? [] : m[2] ? m[2].split(', ') : [])
}
/** built-ins used like tables (FROM OPENJSON(...)) — never "invalid object name" */
const ROWSET_FUNCS = new Set(['OPENJSON', 'STRING_SPLIT', 'GENERATE_SERIES', 'OPENROWSET', 'OPENQUERY', 'OPENXML', 'OPENDATASOURCE', 'CHANGETABLE', 'CONTAINSTABLE', 'FREETEXTTABLE', 'INSERTED', 'DELETED', 'PREDICT'])

const SYS_VARS: Record<string, string> = {
  '@@ROWCOUNT': 'rows affected by the last statement',
  '@@IDENTITY': 'last identity value inserted (any scope)',
  '@@ERROR': 'error number of the last statement, 0 if none',
  '@@TRANCOUNT': 'number of open transactions',
  '@@FETCH_STATUS': 'status of the last cursor FETCH (0 = success)',
  '@@SPID': 'session id of the current connection',
  '@@VERSION': 'SQL Server version and build',
  '@@SERVERNAME': 'name of the server',
  '@@SERVICENAME': 'name of the SQL Server instance',
  '@@DATEFIRST': 'first day of the week (SET DATEFIRST)',
  '@@LANGUAGE': 'current language',
  '@@NESTLEVEL': 'nesting level of the current procedure',
  '@@PROCID': 'object id of the current module',
  '@@MAX_PRECISION': 'precision of decimal and numeric',
  '@@OPTIONS': 'current SET options',
  '@@LOCK_TIMEOUT': 'lock timeout in milliseconds'
}

const SYSTEM_VIEWS: Record<string, string[]> = {
  sys: (
    'objects all_objects tables views columns all_columns procedures parameters schemas indexes index_columns foreign_keys ' +
    'foreign_key_columns key_constraints default_constraints check_constraints triggers types synonyms sql_modules ' +
    'all_sql_modules identity_columns computed_columns extended_properties sequences stats partitions allocation_units ' +
    'databases database_files master_files database_principals server_principals database_role_members ' +
    'database_permissions configurations messages dm_exec_requests dm_exec_sessions dm_exec_connections ' +
    'dm_exec_query_stats dm_exec_procedure_stats dm_exec_cached_plans dm_exec_sql_text dm_exec_query_plan ' +
    'dm_db_index_usage_stats dm_db_index_physical_stats dm_db_missing_index_details dm_db_missing_index_groups ' +
    'dm_db_missing_index_group_stats dm_db_partition_stats dm_os_wait_stats dm_os_performance_counters dm_tran_locks ' +
    'dm_tran_active_transactions dm_exec_query_memory_grants sysprocesses'
  ).split(' '),
  INFORMATION_SCHEMA: (
    'TABLES COLUMNS VIEWS ROUTINES PARAMETERS SCHEMATA TABLE_CONSTRAINTS KEY_COLUMN_USAGE REFERENTIAL_CONSTRAINTS ' +
    'CHECK_CONSTRAINTS CONSTRAINT_COLUMN_USAGE CONSTRAINT_TABLE_USAGE VIEW_COLUMN_USAGE VIEW_TABLE_USAGE ROUTINE_COLUMNS DOMAINS'
  ).split(' ')
}

/** system procedures: parameters */
const SYS_PROCS: Record<string, string[]> = {
  sp_executesql: ['@stmt', '[@params]', '[@param1, ...n]'],
  sp_help: ['[@objname]'],
  sp_helptext: ['@objname', '[@columnname]'],
  sp_helpindex: ['@objname'],
  sp_columns: ['@table_name', '[@table_owner]'],
  sp_tables: ['[@table_name]', '[@table_owner]'],
  sp_spaceused: ['[@objname]', '[@updateusage]'],
  sp_rename: ['@objname', '@newname', '[@objtype]'],
  sp_who: ['[@loginame]'],
  sp_who2: ['[@loginame]'],
  sp_lock: ['[@spid1]', '[@spid2]'],
  sp_depends: ['@objname'],
  sp_configure: ['[@configname]', '[@configvalue]'],
  sp_helpdb: ['[@dbname]'],
  sp_databases: [],
  sp_recompile: ['@objname'],
  sp_refreshview: ['@viewname'],
  sp_addextendedproperty: ['@name', '@value', '@level0type', '@level0name', '[@level1type]', '[@level1name]'],
  sp_set_session_context: ['@key', '@value', '[@read_only]'],
  sp_describe_first_result_set: ['@tsql', '[@params]', '[@browse_information_mode]']
}

const SNIPPETS: [string, string, string][] = [
  ['select-top', 'SELECT TOP (100) …', 'SELECT TOP (${1:100}) ${2:*}\nFROM ${3:table}\nWHERE ${4:1 = 1};'],
  ['insert-into', 'INSERT INTO … VALUES', 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});'],
  ['update-set', 'UPDATE … SET … WHERE', 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};'],
  ['delete-from', 'DELETE FROM … WHERE', 'DELETE FROM ${1:table}\nWHERE ${2:condition};'],
  ['create-table', 'CREATE TABLE', 'CREATE TABLE ${1:dbo}.${2:TableName}\n(\n\t${3:Id} INT IDENTITY(1,1) NOT NULL PRIMARY KEY,\n\t${4:Name} NVARCHAR(100) NULL\n);'],
  ['create-procedure', 'CREATE OR ALTER PROCEDURE', 'CREATE OR ALTER PROCEDURE ${1:dbo}.${2:ProcName}\n\t@${3:Param} ${4:INT}\nAS\nBEGIN\n\tSET NOCOUNT ON;\n\t$0\nEND'],
  ['create-function', 'CREATE OR ALTER FUNCTION (table)', 'CREATE OR ALTER FUNCTION ${1:dbo}.${2:FnName}\n(\n\t@${3:Param} ${4:INT}\n)\nRETURNS TABLE\nAS\nRETURN\n(\n\tSELECT $0\n);'],
  ['create-view', 'CREATE OR ALTER VIEW', 'CREATE OR ALTER VIEW ${1:dbo}.${2:ViewName}\nAS\nSELECT $0'],
  ['cte', 'WITH … AS (…)', 'WITH ${1:cte} AS\n(\n\tSELECT $2\n)\nSELECT * FROM ${1:cte};'],
  ['begin-tran', 'BEGIN TRAN … COMMIT', 'BEGIN TRAN;\n\t$0\nCOMMIT TRAN;'],
  ['try-catch', 'BEGIN TRY … BEGIN CATCH', 'BEGIN TRY\n\t$0\nEND TRY\nBEGIN CATCH\n\tSELECT ERROR_NUMBER() AS ErrorNumber, ERROR_MESSAGE() AS ErrorMessage;\nEND CATCH'],
  ['tran-try-catch', 'transaction with TRY/CATCH', 'BEGIN TRY\n\tBEGIN TRAN;\n\t$0\n\tCOMMIT TRAN;\nEND TRY\nBEGIN CATCH\n\tIF @@TRANCOUNT > 0 ROLLBACK TRAN;\n\tTHROW;\nEND CATCH'],
  ['if-exists', 'IF EXISTS (…)', 'IF EXISTS (SELECT 1 FROM ${1:table} WHERE ${2:condition})\nBEGIN\n\t$0\nEND'],
  ['while', 'WHILE … BEGIN … END', 'WHILE ${1:condition}\nBEGIN\n\t$0\nEND'],
  ['cursor', 'cursor loop', 'DECLARE ${1:cur} CURSOR LOCAL FAST_FORWARD FOR\n\tSELECT ${2:col} FROM ${3:table};\nOPEN ${1:cur};\nFETCH NEXT FROM ${1:cur} INTO @${4:var};\nWHILE @@FETCH_STATUS = 0\nBEGIN\n\t$0\n\tFETCH NEXT FROM ${1:cur} INTO @${4:var};\nEND\nCLOSE ${1:cur};\nDEALLOCATE ${1:cur};'],
  ['find-column', 'find tables having a column', "SELECT s.name AS [schema], t.name AS [table], c.name AS [column]\nFROM sys.columns c\nJOIN sys.tables t ON t.object_id = c.object_id\nJOIN sys.schemas s ON s.schema_id = t.schema_id\nWHERE c.name LIKE N'%${1:name}%'\nORDER BY s.name, t.name;"]
]

const TABLE_LIKE = new Set(['U', 'V', 'IF', 'TF', 'FT', 'SN'])
const PROC_TYPES = new Set(['P', 'X', 'PC'])
const FUNC_TYPES = new Set(['FN', 'FS', 'IF', 'TF', 'FT'])
const KIND_NAME: Record<string, string> = {
  U: 'table', V: 'view', P: 'procedure', X: 'procedure', PC: 'procedure', FN: 'function', FS: 'function', IF: 'table function', TF: 'table function', FT: 'table function', SN: 'synonym'
}
const kindOf = (type: string): monaco.languages.CompletionItemKind =>
  type === 'U' ? K.Struct : type === 'V' ? K.Interface : PROC_TYPES.has(type) ? K.Method : type === 'SN' ? K.Reference : K.Function

/* ======================= reading the script ======================= */

const PART = String.raw`(?:\[(?:[^\]]|\]\])+\]|[\w@#$]+)`
const NAME = String.raw`${PART}(?:\s*\.\s*${PART}){0,3}`
const PART_RE = new RegExp(PART, 'g')
// comments and string literals (also unterminated ones, while typing); bracketed names are skipped over
const NOISE = /\[(?:[^\]]|\]\])*\]?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?/g

const unbracket = (s: string): string => (s.startsWith('[') ? s.slice(1, s.endsWith(']') ? -1 : undefined).replace(/]]/g, ']') : s)
const partsOf = (name: string): string[] => (name.match(PART_RE) ?? []).map(unbracket)
const lc = (s: string): string => s.toLowerCase()

/** comments and strings turned into spaces, same length and lines, so offsets still match */
const blankOut = (text: string): string => text.replace(NOISE, (m) => (m[0] === '[' ? m : m.replace(/[^\n]/g, ' ')))

/** is the end of `prefix` inside a comment or string? */
function insideNoise(prefix: string): boolean {
  let last: RegExpMatchArray | undefined
  for (const m of prefix.matchAll(NOISE)) last = m
  if (!last || last.index! + last[0].length !== prefix.length) return false
  const s = last[0]
  return s.startsWith('--') || (s.startsWith('/*') && !s.endsWith('*/')) || (s[0] === "'" && !/^'(?:[^']|'')*'$/.test(s))
}

function matchParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i
  }
  return s.length
}

function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(s.slice(from, i))
      from = i + 1
    }
  }
  out.push(s.slice(from))
  return out
}

const SELECT_END = /^(FROM|INTO|WHERE|UNION|EXCEPT|INTERSECT|GROUP|ORDER|HAVING|OPTION|FOR)\b/i
/** output column names of the first SELECT in `body` */
function selectColumns(body: string): Col[] {
  const m = /\bSELECT\b/i.exec(body)
  if (!m) return []
  let s = body.slice(m.index + 6)
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /[A-Za-z]/.test(c) && !/[\w@#$]/.test(s[i - 1] ?? ' ') && SELECT_END.test(s.slice(i, i + 12))) {
      s = s.slice(0, i)
      break
    }
  }
  s = s.replace(/^\s*(?:ALL|DISTINCT)\b/i, '').replace(/^\s*TOP\s*(?:\([^)]*\)|\d+)(?:\s+PERCENT)?(?:\s+WITH\s+TIES)?/i, '')
  const out: Col[] = []
  for (const item of splitTop(s)) {
    const t = item.trim()
    let a: RegExpExecArray | null
    let name: string | undefined
    if ((a = new RegExp(`^(${PART})\\s*=(?!=)`).exec(t)) && !t.startsWith('@')) name = a[1]
    else if ((a = new RegExp(`\\bAS\\s+(${PART})$`, 'i').exec(t))) name = a[1]
    else if ((a = new RegExp(`^(?:${PART}\\s*\\.\\s*)*(${PART})$`).exec(t))) name = a[1]
    else if ((a = new RegExp(`[\\s)](${PART})$`).exec(t)) && !RESERVED.has(a[1].toUpperCase())) name = a[1]
    if (name && !/^[\d@]/.test(name)) out.push({ name: unbracket(name), type: '' })
  }
  return out
}

const CONSTRAINT_WORDS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'INDEX', 'FOREIGN', 'CHECK', 'PERIOD'])
/** columns of `CREATE TABLE x ( … )` / `DECLARE @t TABLE ( … )` */
function columnDefs(inner: string): Col[] {
  const out: Col[] = []
  for (const item of splitTop(inner)) {
    const m = new RegExp(`^\\s*(${PART})\\s*([\\s\\S]*)$`).exec(item)
    if (!m || CONSTRAINT_WORDS.has(m[1].toUpperCase())) continue
    const type = /^AS\b/i.test(m[2]) ? 'computed' : (/^[\w.]+(?:\s*\([^)]*\))?/.exec(m[2])?.[0] ?? '')
    out.push({ name: unbracket(m[1]), type: type.replace(/\s+/g, ''), nullable: !/\bNOT\s+NULL\b/i.test(m[2]), pk: /\bPRIMARY\s+KEY\b/i.test(m[2]) })
  }
  return out
}

interface Ref {
  parts: string[]
  alias?: string
  at: number
  end: number
  /** the keyword before it: FROM JOIN UPDATE INTO APPLY MERGE TABLE EXEC */
  kw: string
  /** the word before the keyword (INSERT INTO, TRUNCATE TABLE …) */
  prev: string
}
interface Local {
  name: string
  kind: 'CTE' | 'temp table' | 'table variable' | 'derived table'
  cols: Col[]
  at: number
}
interface Var {
  name: string
  type: string
  at: number
}
interface Analysis {
  text: string
  blank: string
  /** start offsets of the batches (split on GO lines) */
  batches: number[]
  refs: Ref[]
  locals: Local[]
  vars: Var[]
  uses: { at: number; db: string }[]
  /** objects the script itself creates (lower-case last name part) */
  created: Set<string>
}

const NOT_ALIAS = new Set([...RESERVED, ...MORE_KEYWORDS.split(' ')])
const prevWord = (s: string, end: number): string => (/([A-Za-z_]+)\s*$/.exec(s.slice(Math.max(0, end - 40), end))?.[1] ?? '').toUpperCase()

function analyze(text: string): Analysis {
  const blank = blankOut(text)
  const a: Analysis = { text, blank, batches: [0], refs: [], locals: [], vars: [], uses: [], created: new Set() }
  for (const m of blank.matchAll(/^[ \t]*GO(?:[ \t]+\d+)?[ \t]*$/gim)) a.batches.push(m.index! + m[0].length)

  for (const m of blank.matchAll(new RegExp(String.raw`\b(FROM|JOIN|UPDATE|INTO|APPLY|MERGE|TABLE)\s+(${NAME})(?:\s+(?:AS\s+)?(${PART}))?`, 'gid'))) {
    const [at, end] = m.indices![2]!
    const alias = m[3] && !NOT_ALIAS.has(m[3].toUpperCase()) && !m[3].startsWith('@') ? unbracket(m[3]) : undefined
    const kw = m[1].toUpperCase()
    a.refs.push({ parts: partsOf(m[2]), alias, at, end, kw, prev: prevWord(blank, m.index!) })
  }
  for (const m of blank.matchAll(new RegExp(String.raw`\bEXEC(?:UTE)?\s+(?:@[\w@#$]+\s*=\s*)?(${NAME})`, 'gid'))) {
    const [at, end] = m.indices![1]!
    a.refs.push({ parts: partsOf(m[1]), at, end, kw: 'EXEC', prev: '' })
  }
  a.refs.sort((x, y) => x.at - y.at)

  // CTEs: WITH x [(cols)] AS ( … ), y AS ( … )
  for (const m of blank.matchAll(new RegExp(String.raw`(?:\bWITH|,)\s*(${PART})\s*(?:\(([^()]*)\))?\s*AS\s*\(`, 'gid'))) {
    if (NOT_ALIAS.has(m[1].toUpperCase())) continue
    const open = m.index! + m[0].length - 1
    const cols = m[2] ? m[2].split(',').map((c) => ({ name: unbracket(c.trim()), type: '' })).filter((c) => c.name) : selectColumns(blank.slice(open + 1, matchParen(blank, open)))
    a.locals.push({ name: unbracket(m[1]), kind: 'CTE', cols, at: m.indices![1]![0] })
  }
  // derived tables: FROM ( SELECT … ) alias
  for (const m of blank.matchAll(/\b(?:FROM|JOIN|APPLY)\s*\(\s*SELECT\b/gi)) {
    const open = blank.indexOf('(', m.index!)
    const close = matchParen(blank, open)
    const al = new RegExp(`^\\s*(?:AS\\s+)?(${PART})`, 'i').exec(blank.slice(close + 1))
    if (al && !NOT_ALIAS.has(al[1].toUpperCase())) a.locals.push({ name: unbracket(al[1]), kind: 'derived table', cols: selectColumns(blank.slice(open + 1, close)), at: m.index! })
  }
  // CREATE TABLE #t ( … ) / DECLARE @t TABLE ( … )
  for (const m of blank.matchAll(/\bCREATE\s+TABLE\s+(#[\w#@$]+|\[#[^\]]+\])\s*\(|\bDECLARE\s+(@[\w@#$]+)\s+(?:AS\s+)?TABLE\s*\(/gi)) {
    const open = m.index! + m[0].length - 1
    const cols = columnDefs(blank.slice(open + 1, matchParen(blank, open)))
    if (m[1]) a.locals.push({ name: unbracket(m[1]), kind: 'temp table', cols, at: m.index! })
    else a.locals.push({ name: m[2], kind: 'table variable', cols, at: m.index! })
  }
  // SELECT … INTO #t / INTO dbo.NewTable
  for (const r of a.refs) {
    if (r.kw !== 'INTO' || r.prev === 'INSERT' || r.prev === 'MERGE') continue
    const name = r.parts[r.parts.length - 1]
    if (name.startsWith('#')) {
      const sel = blank.slice(0, r.at).toUpperCase().lastIndexOf('SELECT')
      a.locals.push({ name, kind: 'temp table', cols: sel >= 0 ? selectColumns(blank.slice(sel, r.at)) : [], at: r.at })
    } else a.created.add(lc(name))
  }
  for (const m of blank.matchAll(new RegExp(String.raw`\bCREATE\s+(?:OR\s+ALTER\s+)?(?:TABLE|VIEW|PROC|PROCEDURE|FUNCTION|SYNONYM|TYPE|SEQUENCE)\s+(${NAME})`, 'gi'))) {
    const p = partsOf(m[1])
    a.created.add(lc(p[p.length - 1]))
  }
  // variables: DECLARE @x INT, procedure parameters @p NVARCHAR(50) …
  for (const m of blank.matchAll(/(@[\w@#$]+)\s+(?:AS\s+)?((?:\w+\.)?\w+(?:\s*\(\s*(?:max|\d+)(?:\s*,\s*\d+)?\s*\))?)/gi)) {
    const base = lc(m[2].replace(/\s*\(.*$/, '').replace(/^\w+\./, ''))
    if (m[1].startsWith('@@') || !(DATA_TYPE_SET.has(base) || base === 'table' || base === 'cursor')) continue
    a.vars.push({ name: m[1], type: m[2].replace(/\s+/g, ''), at: m.index! })
  }
  for (const m of blank.matchAll(/(?<![\w@])@[\w#$][\w@#$]*/g)) if (!a.vars.some((v) => lc(v.name) === lc(m[0]))) a.vars.push({ name: m[0], type: '', at: m.index! })
  for (const m of blank.matchAll(new RegExp(String.raw`\bUSE\s+(${PART})`, 'gi'))) a.uses.push({ at: m.index!, db: unbracket(m[1]) })
  return a
}

const analyses = new WeakMap<monaco.editor.ITextModel, { version: number; a: Analysis }>()
function analysisOf(model: monaco.editor.ITextModel): Analysis {
  const hit = analyses.get(model)
  if (hit && hit.version === model.getVersionId()) return hit.a
  const a = analyze(model.getValue())
  analyses.set(model, { version: model.getVersionId(), a })
  return a
}

function batchOf(a: Analysis, at: number): [number, number] {
  let start = 0
  let end = a.text.length
  for (const b of a.batches) {
    if (b <= at) start = b
    else {
      end = b
      break
    }
  }
  return [start, end]
}
/** the database in effect at `at`: the script's last USE before it, else the toolbar's */
function dbAt(t: Target, a: Analysis, at: number): string {
  let db = t.database
  for (const u of a.uses) if (u.at < at) db = u.db
  return db
}
function nearest<T extends { at: number }>(list: T[], at: number): T | undefined {
  let best: T | undefined
  for (const x of list) if (!best || Math.abs(x.at - at) < Math.abs(best.at - at)) best = x
  return best
}
/** locals visible at `at`: temp tables anywhere in the script, the rest in the same batch */
function localsAt(a: Analysis, at: number): Local[] {
  const [bs, be] = batchOf(a, at)
  return a.locals.filter((l) => l.kind === 'temp table' || (l.at >= bs && l.at < be))
}
const varsAt = (a: Analysis, at: number): Var[] => {
  const [bs, be] = batchOf(a, at)
  return a.vars.filter((v) => v.at >= bs && v.at < be)
}

/** an alias (or derived table) of that name, the one closest to the cursor */
function aliasAt(a: Analysis, name: string, at: number): Ref | Local | undefined {
  const [bs, be] = batchOf(a, at)
  const n = lc(name)
  const refs = a.refs.filter((r) => r.alias && lc(r.alias) === n && r.at >= bs && r.at < be)
  const derived = a.locals.filter((l) => l.kind === 'derived table' && lc(l.name) === n && l.at >= bs && l.at < be)
  return nearest<Ref | Local>([...refs, ...derived], at)
}

/** a table's columns: [db.][schema.]name, a CTE / temp table / table variable, or an alias */
async function columnsFor(t: Target, a: Analysis, parts: string[], at: number, viaAlias = true): Promise<{ label: string; cols: Col[] } | null> {
  if (parts.length === 1) {
    if (viaAlias) {
      const al = aliasAt(a, parts[0], at)
      if (al) return 'kind' in al ? { label: `${al.kind} ${al.name}`, cols: al.cols } : columnsFor(t, a, al.parts, at, false)
    }
    const local = nearest(
      localsAt(a, at).filter((l) => lc(l.name) === lc(parts[0])),
      at
    )
    if (local) return { label: `${local.kind} ${local.name}`, cols: local.cols }
  }
  if (parts.length > 3) return null
  const db = parts.length === 3 ? parts[0] : dbAt(t, a, at)
  let schema = parts.length >= 2 ? parts[parts.length - 2] : ''
  let name = parts[parts.length - 1]
  if (!schema) {
    const hits = (await catalogOf(t.id, db))?.objects.filter((o) => lc(o.name) === lc(name) && TABLE_LIKE.has(o.type)) ?? []
    const o = hits.find((h) => lc(h.schema) === 'dbo') ?? hits[0]
    if (!o) return null
    schema = o.schema
    name = o.name
  }
  const cols = await columnsOf(t.id, db, schema, name)
  return cols?.length ? { label: `${schema}.${name}`, cols } : null
}

/** objects of a schema: catalog ones, or the system views of sys / INFORMATION_SCHEMA */
async function objectsIn(t: Target, db: string, schema: string): Promise<Obj[]> {
  const sys = Object.keys(SYSTEM_VIEWS).find((s) => lc(s) === lc(schema))
  if (sys) return SYSTEM_VIEWS[sys].map((name) => ({ schema: sys, name, type: 'V' }))
  return (await catalogOf(t.id, db))?.objects.filter((o) => lc(o.schema) === lc(schema)) ?? []
}

/** parameters of a procedure / function named by `parts` */
async function paramsFor(t: Target, a: Analysis, parts: string[], at: number): Promise<{ label: string; params: string[]; proc: boolean } | null> {
  const name = parts[parts.length - 1]
  const sys = SYS_PROCS[lc(name)]
  if (sys && (parts.length === 1 || lc(parts[parts.length - 2]) === 'sys')) return { label: name, params: sys, proc: true }
  if (parts.length > 3) return null
  const db = parts.length === 3 ? parts[0] : dbAt(t, a, at)
  const cat = await catalogOf(t.id, db)
  if (!cat) return null
  const schema = parts.length >= 2 ? parts[parts.length - 2] : ''
  const hits = cat.objects.filter((o) => lc(o.name) === lc(name) && (!schema || lc(o.schema) === lc(schema)) && (PROC_TYPES.has(o.type) || FUNC_TYPES.has(o.type)))
  const o = hits.find((h) => lc(h.schema) === 'dbo') ?? hits[0]
  if (!o) return null
  const ps = cat.params.get(lc(`${o.schema}.${o.name}`)) ?? []
  return { label: `${o.schema}.${o.name}`, params: ps.map((p) => `${p.name} ${p.type}${p.output ? ' OUTPUT' : ''}`), proc: PROC_TYPES.has(o.type) }
}

/** inside `EXEC proc …` after the name: which procedure and which argument */
function execAt(a: Analysis, at: number): { ref: Ref; arg: number; argText: string } | null {
  const [bs] = batchOf(a, at)
  const ref = [...a.refs].reverse().find((r) => r.kw === 'EXEC' && r.end < at && r.at >= bs)
  if (!ref) return null
  const after = a.blank.slice(ref.end, at)
  if (!/^\s/.test(after) || /;|\n\s*(SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE|IF|WHILE|BEGIN|END|DECLARE|SET|PRINT|RETURN|WITH|MERGE|CREATE|ALTER|DROP|GO)\b/i.test(after)) return null
  const args = splitTop(after)
  if (args.length > 1 && args.slice(0, -1).some((x) => x.includes('('))) return null
  return { ref, arg: args.length - 1, argText: args[args.length - 1] }
}

/* ======================= completion ======================= */

const IDENT = /^[A-Za-z_][\w@#$]*$/

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', '@', '#'],
  async provideCompletionItems(model, pos) {
    const t = target
    if (!t || model.uri.toString() !== t.model) return { suggestions: [] }
    const at = model.getOffsetAt(pos)
    if (insideNoise(model.getValue().slice(0, at))) return { suggestions: [] }
    const a = analysisOf(model)

    const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1)
    // typing inside `[...`: the bracket is already there, insert the bare name
    const br = /\[((?:[^\]]|\]\])*)$/.exec(before)
    const inBracket = !!br
    const start = br ? br.index + 1 : before.length - /[\w@#$]*$/.exec(before)![0].length
    const range = new monaco.Range(pos.lineNumber, start + 1, pos.lineNumber, pos.column)
    const head = before.slice(0, inBracket ? start - 1 : start)
    const wordAt = at - (pos.column - 1 - start) - (inBracket ? 1 : 0)
    const [bs] = batchOf(a, at)
    const headBlank = a.blank.slice(bs, wordAt)
    const db = dbAt(t, a, at)
    const quote = (n: string): string => (inBracket || (IDENT.test(n) && !RESERVED.has(n.toUpperCase())) ? n : bracket(n))
    const items: Item[] = []
    const seen = new Set<string>()
    const add = (it: Omit<Item, 'range'>): void => {
      const key = `${it.kind}/${typeof it.label === 'string' ? it.label : it.label.label}`
      if (seen.has(key)) return
      seen.add(key)
      items.push({ ...it, range } as Item)
    }
    const addCols = (cols: Col[], from: string, sort: string): void => {
      for (const c of cols)
        add({
          label: c.name,
          kind: K.Field,
          detail: `${c.type}${c.nullable === false ? ' not null' : ''}${c.pk ? ' · PK' : ''}${c.ref ? ` → ${c.ref}` : ''}`,
          documentation: from,
          insertText: quote(c.name),
          sortText: sort + c.name
        })
    }
    const addObjs = (objs: Obj[], sort: string, qualify: boolean): void => {
      for (const o of objs) {
        const bare = !qualify || lc(o.schema) === 'dbo'
        const label = bare ? o.name : `${o.schema}.${o.name}`
        add({
          label,
          kind: kindOf(o.type),
          detail: `${KIND_NAME[o.type] ?? 'view'} · ${o.schema}`,
          insertText: bare ? quote(o.name) : `${quote(o.schema)}.${quote(o.name)}`,
          sortText: sort + label
        })
      }
    }

    /* ---- after a dot: alias. / table. / schema. / db. / db.schema. ---- */
    const q = new RegExp(`(${NAME})\\s*\\.\\s*$`).exec(head)
    if (q) {
      const p = partsOf(q[1])
      const cols = await columnsFor(t, a, p, at)
      if (cols) addCols(cols.cols, cols.label, '0')
      if (p.length === 1 && !aliasAt(a, p[0], at)) {
        addObjs(await objectsIn(t, db, p[0]), '1', false)
        // db. → its schemas
        if ((await databasesOf(t.id))?.some((d) => lc(d) === lc(p[0])))
          for (const s of (await catalogOf(t.id, p[0]))?.schemas ?? []) add({ label: s, kind: K.Folder, detail: `schema · ${p[0]}`, insertText: quote(s), sortText: '2' + s })
      }
      if (p.length === 2 && (await databasesOf(t.id))?.some((d) => lc(d) === lc(p[0]))) addObjs(await objectsIn(t, p[0], p[1]), '1', false)
      return { suggestions: items }
    }

    const kw = prevWord(headBlank, headBlank.length)
    const cat = await catalogOf(t.id, db)
    const dbs = (await databasesOf(t.id)) ?? []
    const addDbs = (sort: string): void => {
      for (const d of dbs) add({ label: d, kind: K.Module, detail: 'database', insertText: quote(d), sortText: sort + d })
    }
    const addSchemas = (sort: string): void => {
      for (const s of [...(cat?.schemas ?? []), 'sys', 'INFORMATION_SCHEMA']) add({ label: s, kind: K.Folder, detail: 'schema', insertText: quote(s), sortText: sort + s })
    }
    const addLocals = (sort: string): void => {
      for (const l of localsAt(a, at)) if (l.kind !== 'derived table') add({ label: l.name, kind: K.Struct, detail: l.kind, insertText: l.name.startsWith('#') || l.name.startsWith('@') ? l.name : quote(l.name), sortText: sort + l.name })
    }
    const addVars = (sort: string): void => {
      for (const v of varsAt(a, at)) add({ label: v.name, kind: K.Variable, detail: v.type || 'variable', insertText: v.name, sortText: sort + v.name })
      for (const [v, doc] of Object.entries(SYS_VARS)) add({ label: v, kind: K.Variable, detail: 'system function', documentation: doc, insertText: v, sortText: sort + 'z' + v })
    }

    /* ---- USE | ---- */
    if (kw === 'USE') {
      addDbs('0')
      return { suggestions: items }
    }

    /* ---- INSERT INTO t ( | ---- */
    {
      let depth = 0
      let open = -1
      for (let i = headBlank.length - 1; i >= 0; i--) {
        const c = headBlank[i]
        if (c === ')') depth++
        else if (c === '(') {
          if (depth === 0) {
            open = i
            break
          }
          depth--
        }
      }
      const ins = open >= 0 ? new RegExp(`\\bINSERT\\s+(?:INTO\\s+)?(${NAME})\\s*$`, 'i').exec(headBlank.slice(0, open)) : null
      if (ins) {
        const cols = await columnsFor(t, a, partsOf(ins[1]), at, false)
        if (cols) {
          addCols(cols.cols, cols.label, '0')
          return { suggestions: items }
        }
      }
    }

    /* ---- EXEC proc | → its parameters ---- */
    const ex = execAt(a, at)
    if (ex) {
      const ps = await paramsFor(t, a, ex.ref.parts, at)
      for (const p of ps?.params ?? []) {
        const name = p.split(' ')[0].replace(/^\[|\]$/g, '')
        if (!name.startsWith('@')) continue
        add({ label: name, kind: K.Property, detail: p.slice(name.length).trim() || 'parameter', documentation: ps!.label, insertText: `${name} = `, sortText: '0' + name })
      }
      addVars('1')
      for (const k of ['OUTPUT', 'DEFAULT', 'NULL']) add({ label: k, kind: K.Keyword, insertText: k, sortText: '2' + k })
      return { suggestions: items }
    }

    /* ---- EXEC | → procedures ---- */
    if (kw === 'EXEC' || kw === 'EXECUTE') {
      addObjs(cat?.objects.filter((o) => PROC_TYPES.has(o.type)) ?? [], '0', true)
      for (const p of Object.keys(SYS_PROCS)) add({ label: p, kind: K.Method, detail: 'system procedure', insertText: p, sortText: '1' + p })
      addSchemas('2')
      addDbs('3')
      return { suggestions: items }
    }

    /* ---- FROM / JOIN / UPDATE / INTO … | → tables ---- */
    if (['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'APPLY', 'MERGE'].includes(kw)) {
      addLocals('0')
      addObjs(cat?.objects.filter((o) => TABLE_LIKE.has(o.type)) ?? [], '0', true)
      addSchemas('1')
      addDbs('2')
      for (const f of ROWSET_FUNCS) if (BUILTINS.has(f)) add({ label: f, kind: K.Function, detail: 'rowset function', insertText: f, sortText: '3' + f })
      for (const k of KEYWORDS) add({ label: k, kind: K.Keyword, insertText: k, sortText: '4' + k })
      return { suggestions: items }
    }

    /* ---- anywhere else ---- */
    // columns of the tables this batch reads, nearest statements first
    const [b0, b1] = batchOf(a, at)
    const refs = a.refs.filter((r) => r.at >= b0 && r.at < b1 && r.kw !== 'EXEC').sort((x, y) => Math.abs(x.at - at) - Math.abs(y.at - at)).slice(0, 12)
    const found = await Promise.all(refs.map((r) => columnsFor(t, a, r.parts, at, false)))
    for (const [i, f] of found.entries()) if (f) addCols(f.cols, refs[i].alias ? `${f.label} (${refs[i].alias})` : f.label, '0')
    for (const l of localsAt(a, at)) if (l.kind === 'derived table' && l.at >= b0 && l.at < b1) addCols(l.cols, `${l.kind} ${l.name}`, '0')
    // aliases themselves
    for (const r of refs) if (r.alias) add({ label: r.alias, kind: K.Reference, detail: `alias · ${r.parts.join('.')}`, insertText: r.alias, sortText: '1' + r.alias })
    addVars('1')
    for (const k of KEYWORDS) add({ label: k, kind: K.Keyword, insertText: k, sortText: '2' + k })
    for (const [f, ps] of BUILTINS) add({ label: f, kind: K.Function, detail: `${f}(${ps.join(', ')})`, insertText: f, sortText: '2' + f })
    for (const d of DATA_TYPES) add({ label: d, kind: K.TypeParameter, detail: 'data type', insertText: d, sortText: '3' + d })
    addLocals('3')
    addObjs(cat?.objects ?? [], '4', true)
    addSchemas('4')
    addDbs('5')
    for (const [label, detail, body] of SNIPPETS)
      add({ label, kind: K.Snippet, detail, insertText: body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, sortText: '6' + label })
    return { suggestions: items }
  }
})

/* ======================= Parameter Info ======================= */

function signature(name: string, params: string[], open = '(', close = ')'): monaco.languages.SignatureInformation {
  let label = name + open
  const parameters: monaco.languages.ParameterInformation[] = []
  params.forEach((p, i) => {
    if (i) label += ', '
    parameters.push({ label: [label.length, label.length + p.length] })
    label += p
  })
  return { label: label + close, parameters }
}

monaco.languages.registerSignatureHelpProvider('sql', {
  signatureHelpTriggerCharacters: ['(', ',', ' '],
  signatureHelpRetriggerCharacters: [','],
  async provideSignatureHelp(model, pos) {
    const t = target
    if (!t || model.uri.toString() !== t.model) return null
    const at = model.getOffsetAt(pos)
    if (insideNoise(model.getValue().slice(0, at))) return null
    const a = analysisOf(model)
    const [bs] = batchOf(a, at)
    const seg = a.blank.slice(bs, at)
    let depth = 0
    let open = -1
    let commas = 0
    for (let i = seg.length - 1; i >= 0; i--) {
      const c = seg[i]
      if (c === ')') depth++
      else if (c === '(') {
        if (depth === 0) {
          open = i
          break
        }
        depth--
      } else if (c === ',' && depth === 0) commas++
    }
    const result = (sig: monaco.languages.SignatureInformation, arg: number): monaco.languages.SignatureHelpResult => ({
      value: { signatures: [sig], activeSignature: 0, activeParameter: Math.min(arg, Math.max(0, sig.parameters.length - 1)) },
      dispose() {}
    })
    if (open >= 0) {
      const nm = new RegExp(`(${NAME})\\s*$`).exec(seg.slice(0, open))
      if (!nm) return null
      const parts = partsOf(nm[1])
      const up = parts[parts.length - 1].toUpperCase()
      if (parts.length === 1 && BUILTINS.has(up)) return result(signature(up, BUILTINS.get(up)!), commas)
      const ps = await paramsFor(t, a, parts, at)
      return ps && !ps.proc ? result(signature(ps.label, ps.params), commas) : null
    }
    const ex = execAt(a, at)
    if (!ex) return null
    const ps = await paramsFor(t, a, ex.ref.parts, at)
    if (!ps) return null
    const sig = signature(ps.label, ps.params, ' ', '')
    // a named argument (@p = …) points at that parameter
    const named = /^\s*(@[\w@#$]+)\s*=/.exec(ex.argText)?.[1]
    const byName = named ? ps.params.findIndex((p) => lc(p.split(' ')[0].replace(/^\[|\]$/g, '')) === lc(named)) : -1
    return result(sig, byName >= 0 ? byName : ex.arg)
  }
})

/* ======================= Quick Info (hover) ======================= */

const code = (s: string): string => '```sql\n' + s + '\n```'
const colLine = (c: Col): string => `${c.name} ${c.type}${c.nullable === false ? ' NOT NULL' : ''}${c.pk ? ' -- PK' : ''}${c.ref ? ` -- → ${c.ref}` : ''}`.trim()
const listCols = (cols: Col[]): string => cols.slice(0, 40).map(colLine).join('\n') + (cols.length > 40 ? `\n-- … ${cols.length - 40} more` : '')

async function describeObject(t: Target, a: Analysis, o: Obj, db: string, at: number): Promise<string> {
  const head = `(${KIND_NAME[o.type] ?? 'view'}) ${db ? `${db}.` : ''}${o.schema}.${o.name}`
  if (TABLE_LIKE.has(o.type) && o.type !== 'SN') {
    const cols = await columnsFor(t, a, [db || dbAt(t, a, at), o.schema, o.name].filter(Boolean).slice(-3), at, false)
    return code(head + (cols ? '\n' + listCols(cols.cols) : ''))
  }
  if (PROC_TYPES.has(o.type) || FUNC_TYPES.has(o.type)) {
    const ps = await paramsFor(t, a, [o.schema, o.name], at)
    return code(head + (ps?.params.length ? '\n  ' + ps.params.join(',\n  ') : ''))
  }
  return code(head)
}

monaco.languages.registerHoverProvider('sql', {
  async provideHover(model, pos) {
    const t = target
    if (!t || model.uri.toString() !== t.model) return null
    const line = model.getLineContent(pos.lineNumber)
    const col = pos.column - 1
    let chain: RegExpMatchArray | undefined
    for (const m of line.matchAll(new RegExp(`${PART}(?:\\s*\\.\\s*${PART})*`, 'g'))) if (m.index! <= col && col < m.index! + m[0].length) chain = m
    if (!chain) return null
    const parts: { text: string; from: number; to: number }[] = []
    for (const m of chain[0].matchAll(PART_RE)) parts.push({ text: unbracket(m[0]), from: chain.index! + m.index!, to: chain.index! + m.index! + m[0].length })
    const idx = parts.findIndex((p) => p.from <= col && col < p.to)
    if (idx < 0) return null
    const hovered = parts[idx]
    const at = model.getOffsetAt({ lineNumber: pos.lineNumber, column: hovered.from + 1 })
    if (insideNoise(model.getValue().slice(0, at))) return null
    const a = analysisOf(model)
    const range = new monaco.Range(pos.lineNumber, hovered.from + 1, pos.lineNumber, hovered.to + 1)
    const q = parts.slice(0, idx).map((p) => p.text)
    const name = hovered.text
    const n = lc(name)
    const db = dbAt(t, a, at)
    const show = (md: string | null): monaco.languages.Hover | null => (md ? { range, contents: [{ value: md }] } : null)

    if (name.startsWith('@@')) return show(SYS_VARS[name.toUpperCase()] ? code(name.toUpperCase()) + '\n\n' + SYS_VARS[name.toUpperCase()] : null)
    if (name.startsWith('@')) {
      const v = varsAt(a, at).find((x) => lc(x.name) === n)
      const tv = localsAt(a, at).find((l) => lc(l.name) === n)
      return show(tv ? code(`(table variable) ${tv.name}\n${listCols(tv.cols)}`) : v ? code(`${v.name} ${v.type}`.trim()) : null)
    }

    if (q.length) {
      const cols = await columnsFor(t, a, q, at)
      const c = cols?.cols.find((x) => lc(x.name) === n)
      if (c) return show(code(`(column) ${cols!.label}.${colLine(c)}`))
      const objDb = q.length === 2 ? q[0] : db
      const o = (await objectsIn(t, objDb, q[q.length - 1])).find((x) => lc(x.name) === n)
      if (o) return show(await describeObject(t, a, o, q.length === 2 ? q[0] : '', at))
      if (q.length === 1 && (await databasesOf(t.id))?.some((d) => lc(d) === lc(q[0]))) return show(code(`(schema) ${q[0]}.${name}`))
      return null
    }

    const nextChar = line.slice(hovered.to).trimStart()[0]
    if (nextChar === '(' && BUILTINS.has(name.toUpperCase())) return show(code(signature(name.toUpperCase(), BUILTINS.get(name.toUpperCase())!).label as string))
    const al = aliasAt(a, name, at)
    if (al) {
      if ('kind' in al) return show(code(`(${al.kind}) ${al.name}\n${listCols(al.cols)}`))
      const cols = await columnsFor(t, a, al.parts, at, false)
      return show(code(`(alias) ${al.alias} → ${al.parts.join('.')}` + (cols ? '\n' + listCols(cols.cols) : '')))
    }
    const local = localsAt(a, at).find((l) => lc(l.name) === n)
    if (local) return show(code(`(${local.kind}) ${local.name}\n${listCols(local.cols)}`))
    const cat = await catalogOf(t.id, db)
    const hits = cat?.objects.filter((o) => lc(o.name) === n) ?? []
    const o = hits.find((h) => lc(h.schema) === 'dbo') ?? hits[0]
    if (o) return show(await describeObject(t, a, o, '', at))
    // a column of a table this batch reads
    const [b0, b1] = batchOf(a, at)
    const refs = a.refs.filter((r) => r.at >= b0 && r.at < b1 && r.kw !== 'EXEC').sort((x, y) => Math.abs(x.at - at) - Math.abs(y.at - at))
    for (const r of refs) {
      const cols = await columnsFor(t, a, r.parts, at, false)
      const c = cols?.cols.find((x) => lc(x.name) === n)
      if (c) return show(code(`(column) ${cols!.label}.${colLine(c)}`))
    }
    if (cat?.schemas.some((s) => lc(s) === n)) return show(code(`(schema) ${name}`))
    if ((await databasesOf(t.id))?.some((d) => lc(d) === n)) return show(code(`(database) ${name}`))
    if (BUILTINS.has(name.toUpperCase())) return show(code(signature(name.toUpperCase(), BUILTINS.get(name.toUpperCase())!).label as string))
    return null
  }
})

/* ======================= squiggles: invalid object names ======================= */

const OWNER = 'sql-schema'
const watched = new WeakSet<monaco.editor.ITextModel>()
let timer: ReturnType<typeof setTimeout> | undefined

function watch(model: monaco.editor.ITextModel): void {
  if (!watched.has(model)) {
    watched.add(model)
    model.onDidChangeContent(() => {
      clearTimeout(timer)
      timer = setTimeout(() => validate(model), 600)
    })
  }
  validate(model)
}

async function validate(model: monaco.editor.ITextModel): Promise<void> {
  const t = target
  if (model.isDisposed()) return
  if (!t || model.uri.toString() !== t.model) return monaco.editor.setModelMarkers(model, OWNER, [])
  const version = model.getVersionId()
  const a = analysisOf(model)
  const dbs = (await databasesOf(t.id)) ?? []
  const markers: monaco.editor.IMarkerData[] = []
  for (const r of a.refs) {
    const p = r.parts
    const name = p[p.length - 1]
    if (!name || /^[@#]/.test(name) || /^[@#]/.test(p[0])) continue
    if (r.kw === 'INTO' && r.prev !== 'INSERT' && r.prev !== 'MERGE') continue
    if (r.kw === 'TABLE' && r.prev !== 'ALTER' && r.prev !== 'TRUNCATE') continue
    if (r.kw === 'FROM') {
      const before = a.blank.slice(Math.max(0, r.at - 200), r.at)
      // IS DISTINCT FROM x, FETCH NEXT FROM cursor, REVOKE … FROM user, TRIM(… FROM x)
      if (/\bDISTINCT\s+FROM\s*$/i.test(before) || /\bFETCH\b[^;]*$/i.test(before) || /\bREVOKE\b[^;\n]*$/i.test(before) || /\bTRIM\s*\([^()]*$/i.test(before)) continue
    }
    if (p.length === 1 && (RESERVED.has(name.toUpperCase()) || ROWSET_FUNCS.has(name.toUpperCase()))) continue
    if (p.length >= 2 && /^(sys|information_schema)$/i.test(p[p.length - 2])) continue
    if (r.kw === 'EXEC' && (/^(sp|xp)_/i.test(name) || p.length === 4)) continue
    if (p.length === 4 || (p.length === 3 && !dbs.some((d) => lc(d) === lc(p[0])))) continue
    if (a.created.has(lc(name))) continue
    if (p.length === 1 && (localsAt(a, r.at).some((l) => lc(l.name) === lc(name)) || aliasAt(a, name, r.at))) continue
    const db = p.length === 3 ? p[0] : dbAt(t, a, r.at)
    const cat = await catalogOf(t.id, db)
    if (!cat) continue
    const schema = p.length >= 2 ? lc(p[p.length - 2]) : ''
    if (cat.objects.some((o) => lc(o.name) === lc(name) && (!schema || lc(o.schema) === schema))) continue
    const s = model.getPositionAt(r.at)
    const e = model.getPositionAt(r.end)
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      message: r.kw === 'EXEC' ? `Could not find stored procedure '${p.join('.')}'.` : `Invalid object name '${p.join('.')}'.`,
      startLineNumber: s.lineNumber,
      startColumn: s.column,
      endLineNumber: e.lineNumber,
      endColumn: e.column
    })
  }
  if (model.isDisposed() || model.getVersionId() !== version || target !== t) return
  monaco.editor.setModelMarkers(model, OWNER, markers)
}
