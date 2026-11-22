import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Circle, CircleCheck, CircleDot, ClipboardList, Ellipsis, Folder, FolderOpen, Loader2, MessageSquarePlus, RefreshCw, Search, Sparkles, Trash2, Users } from 'lucide-react'
import type { ZaloIncoming, ZaloTask, ZaloTasksState } from '../../../../shared/types'
import { listTime } from './util'
import { Avatar } from './Avatar'
import { basename, useStore } from '../../store'
import { newChatFromZaloTask } from '../../actions'
import { tr, useT } from '../../i18n'
import type { T } from '../../i18n'

const SECTIONS = (t: T): { key: ZaloTask['status']; label: string }[] => [
  { key: 'todo', label: t('To do', 'Cần làm') },
  { key: 'doing', label: t('In progress', 'Đang xử lý') },
  { key: 'done', label: t('Done', 'Hoàn thành') }
]
const NEXT: Record<ZaloTask['status'], ZaloTask['status']> = { todo: 'doing', doing: 'done', done: 'todo' }

/**
 * "Việc của tôi" on the Zalo tab: Claude reads messages sent to me / @mentions and keeps a checklist.
 * Replies are sent from the phone — my own messages sync back and move items to doing/done.
 */
export function ZaloTasks(): React.JSX.Element {
  const t = useT()
  const [s, setS] = useState<ZaloTasksState>({ tasks: [], running: false, analyzedAt: 0 })
  const [showDone, setShowDone] = useState(false)
  const [menu, setMenu] = useState<{ t: ZaloTask; x: number; y: number } | null>(null)
  /** a chat being prepared from a task (downloading its photos / files) */
  const [preparing, setPreparing] = useState<string | null>(null)
  const startChat = async (t: ZaloTask, cwd: string | null): Promise<void> => {
    setPreparing(t.title)
    try {
      await newChatFromZaloTask(t.id, t.title, cwd)
      if (t.status === 'todo') void window.api.zalo.setTaskStatus(t.id, 'doing')
    } catch (e) {
      window.alert(tr('Could not create the chat: ', 'Không tạo được chat: ') +(e instanceof Error ? e.message : String(e)))
    } finally {
      setPreparing(null)
    }
  }
  // "mới" / "cập nhật" tags: kept while I'm on the tab even though main already counts them as seen
  const [tags, setTags] = useState<Record<string, 'new' | 'updated'>>({})
  const onTab = useStore((st) => st.centerView === 'zalo')
  useEffect(() => {
    if (!onTab) setTags({})
  }, [onTab])
  useEffect(() => {
    const add: Record<string, 'new' | 'updated'> = { ...s.unseen }
    for (const id of s.changed ?? []) add[id] ??= 'updated'
    for (const id of s.fresh ?? []) add[id] = 'new'
    if (Object.keys(add).length) setTags((t) => ({ ...t, ...add }))
  }, [s.unseen, s.changed, s.fresh])

  useEffect(() => {
    // a fetch answered after a newer push must not put the older list back (a task you just
    // ticked flipped back): every push or new fetch makes the ones in flight stale
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const fetchTasks = (): Promise<ZaloTasksState> => {
      const my = ++seq
      return window.api.zalo.tasks().then((st) => {
        if (my === seq) setS(st)
        return st
      })
    }
    void fetchTasks().then((st) => {
      // first look of the day: refresh once on its own
      if (!st.running && Date.now() - st.analyzedAt > 30 * 60_000) void window.api.zalo.analyzeTasks()
    })
    const offT = window.api.zalo.onTasks((st) => {
      seq++
      setS(st)
    })
    // avatars arrive with profile fetches (in bursts) → one refresh after the burst so they show up
    const offC = window.api.zalo.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void fetchTasks(), 300)
    })
    return () => {
      offT()
      offC()
      clearTimeout(timer)
    }
  }, [])

  const groups = useMemo(() => Object.fromEntries(SECTIONS(t).map((x) => [x.key, s.tasks.filter((t) => t.status === x.key)])) as Record<ZaloTask['status'], ZaloTask[]>, [s.tasks, t])
  const pending = groups.todo.length + groups.doing.length

  return (
    <div className="zt-panel">
      <div className="zt-head">
        <ClipboardList size={18} className="zt-head-icon" />
        <div>
          <div className="zt-title">{t('My tasks', 'Việc của tôi')}</div>
          <div className="zt-sub">
            {s.running
              ? t('Claude is reading messages…', 'Claude đang đọc tin nhắn…')
              : s.analyzedAt
                ? t(
                    `${pending} unfinished ${pending === 1 ? 'task' : 'tasks'} · updated ${listTime(s.analyzedAt, t)}`,
                    `${pending} việc chưa xong · cập nhật ${listTime(s.analyzedAt, t)}`
                  )
                : t('Not analyzed yet', 'Chưa phân tích')}
          </div>
        </div>
        <button className="zl-icon" title={t('Have Claude re-read messages', 'Claude đọc lại tin nhắn')} disabled={s.running} onClick={() => void window.api.zalo.analyzeTasks()}>
          <RefreshCw size={16} className={s.running ? 'zl-spin' : undefined} />
        </button>
      </div>
      {s.error && <div className="zt-error">{s.error}</div>}
      {preparing && (
        <div className="zt-prep">
          <Loader2 size={13} className="zl-spin" /> {t('Fetching the conversation, photos and files for the new chat:', 'Đang lấy đoạn chat, ảnh và tệp cho chat mới:')} {preparing}
        </div>
      )}
      {!!s.incoming?.length && <Incoming list={s.incoming} running={s.running} dueAt={s.dueAt} />}
      <div className="zt-body">
        {s.tasks.length === 0 && !s.incoming?.length && (
          <div className="zt-empty">
            {s.running ? <Loader2 size={18} className="zl-spin" /> : <Sparkles size={18} />}
            {s.running
              ? t('Looking for tasks in direct messages and groups that @mention you…', 'Đang tìm việc trong tin nhắn cá nhân và nhóm có @ bạn…')
              : t('No tasks. Direct messages and group messages that @mention you will be summed up here.', 'Không có việc nào. Tin nhắn cá nhân và nhóm @ bạn sẽ được tóm tắt vào đây.')}
          </div>
        )}
        {SECTIONS(t).map(({ key, label }) => {
          const list = groups[key]
          if (!list.length) return null
          const folded = key === 'done' && !showDone
          return (
            <section key={key} className={'zt-sec ' + key}>
              <button className="zt-sec-h" onClick={() => key === 'done' && setShowDone((v) => !v)}>
                <span className="zt-dot" />
                {label}
                <span className="zt-sec-n">{list.length}</span>
                {key === 'done' && <ChevronDown size={14} className={folded ? 'zt-fold' : ''} />}
              </button>
              {!folded && list.map((t) => <Row key={t.id} t={t} tag={tags[t.id]} onMenu={(x, y) => setMenu({ t, x, y })} />)}
            </section>
          )
        })}
      </div>
      <div className="zt-foot">
        {t(
          'Reply in Zalo on your phone — your messages sync back and tasks change status by themselves. Right-click a task to change its status or create a chat.',
          'Trả lời trên Zalo điện thoại — tin của bạn đồng bộ về và việc tự chuyển trạng thái. Chuột phải vào việc để đổi trạng thái hoặc tạo chat.'
        )}
      </div>
      {menu && <TaskMenu {...menu} onClose={() => setMenu(null)} onChat={(cwd) => void startChat(menu.t, cwd)} />}
    </div>
  )
}

/** New messages to me being turned into tasks: who sent what, with an indeterminate progress bar. */
function Incoming({ list, running, dueAt }: { list: ZaloIncoming[]; running: boolean; dueAt?: number }): React.JSX.Element {
  const t = useT()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!dueAt) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [dueAt])
  const left = dueAt ? Math.max(0, Math.ceil((dueAt - now) / 1000)) : 0
  return (
    <div className="zt-inc">
      <div className="zt-inc-h">
        <Loader2 size={13} className="zl-spin" />
        {running
          ? t(`Claude is creating tasks from ${list.length} ${list.length === 1 ? 'message' : 'messages'}…`, `Claude đang tạo công việc từ ${list.length} tin nhắn…`)
          : left > 0
            ? t(
                `Collecting ${list.length} ${list.length === 1 ? 'message' : 'messages'} — sending to the AI in ${left}s if no new ones arrive`,
                `Đang gom ${list.length} tin nhắn — gửi AI sau ${left}s nếu không có tin mới`
              )
            : t('Waiting to create tasks…', 'Đang chờ tạo công việc…')}
      </div>
      {list.slice(-3).map((m) => (
        <div key={m.msgId} className="zt-inc-row">
          <Avatar id={m.threadId} name={m.from} src={m.avatar} size={24} />
          <div className="zt-inc-main">
            <span className="zt-inc-from">
              {m.from}
              {m.group && <span className="zt-inc-thread"> · {m.threadName}</span>}
            </span>
            <span className="zt-inc-text">{m.text}</span>
          </div>
        </div>
      ))}
      {list.length > 3 && <div className="zt-inc-more">{t(`+${list.length - 3} more`, `+${list.length - 3} tin khác`)}</div>}
      <div className="zt-progress">
        <i />
      </div>
    </div>
  )
}

function Row({ t, tag, onMenu }: { t: ZaloTask; tag?: 'new' | 'updated'; onMenu: (x: number, y: number) => void }): React.JSX.Element {
  const tl = useT()
  return (
    <div
      className={'zt-row ' + t.status + (tag ? ' fresh' : '')}
      onContextMenu={(e) => {
        // keep the browser menu (Copy) while text is selected inside the task
        if (window.getSelection()?.toString()) return
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <button
        className="zt-check"
        title={t.status === 'todo' ? tl('Mark as in progress', 'Đánh dấu đang xử lý') : t.status === 'doing' ? tl('Mark as done', 'Đánh dấu hoàn thành') : tl('Reopen', 'Mở lại')}
        onClick={() => void window.api.zalo.setTaskStatus(t.id, NEXT[t.status])}
      >
        {t.status === 'done' ? <Check size={13} /> : t.status === 'doing' ? <CircleDot size={13} /> : null}
      </button>
      <Avatar id={t.fromId ?? t.threadId} name={t.from} src={t.avatar} size={30} />
      <div className="zt-main">
        <span className="zt-row-title">{t.title}</span>
        {t.detail && <span className="zt-row-detail">{t.detail}</span>}
        <span className="zt-row-meta">
          {t.group && <Users size={11} />}
          {t.group ? `${t.threadName} · ${t.from}` : t.from} · {listTime(t.ts, tl)}
          {t.manual && <span className="zt-manual">{tl('· set by hand', '· đặt tay')}</span>}
          {tag === 'new' && <span className="zt-new">{tl('new', 'mới')}</span>}
          {tag === 'updated' && <span className="zt-new upd">{tl('updated', 'cập nhật')}</span>}
        </span>
      </div>
      <button
        className="zt-more"
        title={tl('Options: status, open a code chat…', 'Tuỳ chọn: trạng thái, mở chat code…')}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          onMenu(r.right - 4, r.bottom + 4)
        }}
      >
        <Ellipsis size={15} />
      </button>
      <button className="zt-del" title={tl('Remove from the list', 'Xoá khỏi danh sách')} onClick={() => void window.api.zalo.removeTask(t.id)}>
        <Trash2 size={13} />
      </button>
    </div>
  )
}

const STATUS_ITEMS = (tl: T): { key: ZaloTask['status']; label: string; icon: React.JSX.Element }[] => [
  { key: 'todo', label: tl('To do', 'Cần làm'), icon: <Circle size={16} /> },
  { key: 'doing', label: tl('In progress', 'Đang xử lý'), icon: <CircleDot size={16} /> },
  { key: 'done', label: tl('Done', 'Hoàn thành'), icon: <CircleCheck size={16} /> }
]

/**
 * Right-click on a task: set its status by hand, or start a coding chat in a project with the conversation as context.
 * Without `t` (the Gmail tab) it opens straight on the project picker.
 */
export function TaskMenu({ t, x, y, onClose, onChat }: { t?: ZaloTask; x: number; y: number; onClose: () => void; onChat: (cwd: string | null) => void }): React.JSX.Element {
  const tl = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [pick, setPick] = useState(!t)
  const root = useStore((s) => s.root)
  const projects = useStore((s) => s.projects)
  const recent = useStore((s) => s.recent)
  const folders = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const add = (p?: string | null): void => {
      const k = p?.replace(/[\\/]+$/, '').toLowerCase()
      if (!p || !k || seen.has(k)) return
      seen.add(k)
      out.push(p)
    }
    add(root)
    ;[...projects].sort((a, b) => b.updated - a.updated).forEach((g) => add(g.cwd))
    recent.forEach(add)
    return out
  }, [root, projects, recent])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return words.length ? folders.filter((f) => words.every((w) => f.toLowerCase().includes(w))) : folders
  }, [folders, q])
  useEffect(() => setSel(0), [q])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
  }, [x, y, pick])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }
  // portal to <body>: a transformed/blurred ancestor would offset position:fixed
  return createPortal(
    <>
      <div
        className="zl-scrim"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="zl-ctx zt-ctx" ref={ref} style={pos}>
        <div className="zl-ctx-list">
          {!pick && t ? (
            <>
              {STATUS_ITEMS(tl).map((it) => (
                <button key={it.key} className={t.status === it.key ? 'on' : ''} onClick={run(() => void window.api.zalo.setTaskStatus(t.id, it.key))}>
                  {it.icon} {it.key === 'done' && t.status !== 'done' ? tl('Mark as done', 'Đánh dấu hoàn thành') : it.label}
                  {t.status === it.key && <Check size={14} className="zt-ctx-tick" />}
                </button>
              ))}
              <div className="zt-ctx-sep" />
              <button onClick={() => setPick(true)}>
                <MessageSquarePlus size={16} /> {tl('New chat from this task…', 'Tạo chat mới từ việc này…')}
              </button>
              <div className="zt-ctx-sep" />
              <button className="danger" onClick={run(() => void window.api.zalo.removeTask(t.id))}>
                <Trash2 size={16} /> {tl('Remove from the list', 'Xoá khỏi danh sách')}
              </button>
            </>
          ) : (
            <>
              <div className="zt-ctx-h">{tl(`Choose a project for the new chat (${folders.length})`, `Chọn project cho chat mới (${folders.length})`)}</div>
              <div className="zt-ctx-search">
                <Search size={14} />
                <input
                  autoFocus
                  placeholder={tl('Search projects…', 'Tìm project…')}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      setSel((s) => Math.max(0, Math.min(shown.length - 1, s + (e.key === 'ArrowDown' ? 1 : -1))))
                    } else if (e.key === 'Enter' && shown[sel]) run(() => onChat(shown[sel]))()
                  }}
                />
              </div>
              <div className="zt-ctx-projects">
                {shown.map((f, i) => (
                  <button
                    key={f}
                    title={f}
                    className={i === sel ? 'sel' : ''}
                    ref={i === sel ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                    onMouseEnter={() => setSel(i)}
                    onClick={run(() => onChat(f))}
                  >
                    <Folder size={16} /> <span className="zt-ctx-name">{basename(f)}</span>
                    <span className="zt-ctx-path">{f}</span>
                  </button>
                ))}
                {shown.length === 0 && <div className="zt-ctx-empty">{tl('No matching projects', 'Không có project nào khớp')}</div>}
              </div>
              <div className="zt-ctx-sep" />
              <button onClick={run(() => onChat(null))}>
                <FolderOpen size={16} /> {tl('Choose another folder…', 'Chọn thư mục khác…')}
              </button>
            </>
          )}
        </div>
      </div>
    </>,
    document.body
  )
}
