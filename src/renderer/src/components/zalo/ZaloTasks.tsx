import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, CircleDot, ClipboardList, Loader2, RefreshCw, Sparkles, Trash2, Users } from 'lucide-react'
import type { ZaloIncoming, ZaloTask, ZaloTasksState } from '../../../../shared/types'
import { listTime } from './util'
import { Avatar } from './Avatar'
import { useStore } from '../../store'

const SECTIONS: { key: ZaloTask['status']; label: string }[] = [
  { key: 'todo', label: 'Cần làm' },
  { key: 'doing', label: 'Đang xử lý' },
  { key: 'done', label: 'Hoàn thành' }
]
const NEXT: Record<ZaloTask['status'], ZaloTask['status']> = { todo: 'doing', doing: 'done', done: 'todo' }

/**
 * "Việc của tôi" on the Zalo tab: Claude reads messages sent to me / @mentions and keeps a checklist.
 * Replies are sent from the phone — my own messages sync back and move items to doing/done.
 */
export function ZaloTasks(): React.JSX.Element {
  const [s, setS] = useState<ZaloTasksState>({ tasks: [], running: false, analyzedAt: 0 })
  const [showDone, setShowDone] = useState(false)
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
    void window.api.zalo.tasks().then((st) => {
      setS(st)
      // first look of the day: refresh once on its own
      if (!st.running && Date.now() - st.analyzedAt > 30 * 60_000) void window.api.zalo.analyzeTasks()
    })
    const offT = window.api.zalo.onTasks(setS)
    // avatars arrive with profile fetches → refresh so they show up
    const offC = window.api.zalo.onChanged(() => void window.api.zalo.tasks().then(setS))
    return () => {
      offT()
      offC()
    }
  }, [])

  const groups = useMemo(() => Object.fromEntries(SECTIONS.map((x) => [x.key, s.tasks.filter((t) => t.status === x.key)])) as Record<ZaloTask['status'], ZaloTask[]>, [s.tasks])
  const pending = groups.todo.length + groups.doing.length

  return (
    <div className="zt-panel">
      <div className="zt-head">
        <ClipboardList size={18} className="zt-head-icon" />
        <div>
          <div className="zt-title">Việc của tôi</div>
          <div className="zt-sub">
            {s.running ? 'Claude đang đọc tin nhắn…' : s.analyzedAt ? `${pending} việc chưa xong · cập nhật ${listTime(s.analyzedAt)}` : 'Chưa phân tích'}
          </div>
        </div>
        <button className="zl-icon" title="Claude đọc lại tin nhắn" disabled={s.running} onClick={() => void window.api.zalo.analyzeTasks()}>
          <RefreshCw size={16} className={s.running ? 'zl-spin' : undefined} />
        </button>
      </div>
      {s.error && <div className="zt-error">{s.error}</div>}
      {!!s.incoming?.length && <Incoming list={s.incoming} running={s.running} dueAt={s.dueAt} />}
      <div className="zt-body">
        {s.tasks.length === 0 && !s.incoming?.length && (
          <div className="zt-empty">
            {s.running ? <Loader2 size={18} className="zl-spin" /> : <Sparkles size={18} />}
            {s.running ? 'Đang tìm việc trong tin nhắn cá nhân và nhóm có @ bạn…' : 'Không có việc nào. Tin nhắn cá nhân và nhóm @ bạn sẽ được tóm tắt vào đây.'}
          </div>
        )}
        {SECTIONS.map(({ key, label }) => {
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
              {!folded && list.map((t) => <Row key={t.id} t={t} tag={tags[t.id]} />)}
            </section>
          )
        })}
      </div>
      <div className="zt-foot">Trả lời trên Zalo điện thoại — tin của bạn đồng bộ về và việc tự chuyển trạng thái.</div>
    </div>
  )
}

/** New messages to me being turned into tasks: who sent what, with an indeterminate progress bar. */
function Incoming({ list, running, dueAt }: { list: ZaloIncoming[]; running: boolean; dueAt?: number }): React.JSX.Element {
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
          ? `Claude đang tạo công việc từ ${list.length} tin nhắn…`
          : left > 0
            ? `Đang gom ${list.length} tin nhắn — gửi AI sau ${left}s nếu không có tin mới`
            : 'Đang chờ tạo công việc…'}
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
      {list.length > 3 && <div className="zt-inc-more">+{list.length - 3} tin khác</div>}
      <div className="zt-progress">
        <i />
      </div>
    </div>
  )
}

function Row({ t, tag }: { t: ZaloTask; tag?: 'new' | 'updated' }): React.JSX.Element {
  return (
    <div className={'zt-row ' + t.status + (tag ? ' fresh' : '')}>
      <button
        className="zt-check"
        title={t.status === 'todo' ? 'Đánh dấu đang xử lý' : t.status === 'doing' ? 'Đánh dấu hoàn thành' : 'Mở lại'}
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
          {t.group ? `${t.threadName} · ${t.from}` : t.from} · {listTime(t.ts)}
          {t.manual && <span className="zt-manual">· đặt tay</span>}
          {tag === 'new' && <span className="zt-new">mới</span>}
          {tag === 'updated' && <span className="zt-new upd">cập nhật</span>}
        </span>
      </div>
      <button className="zt-del" title="Xoá khỏi danh sách" onClick={() => void window.api.zalo.removeTask(t.id)}>
        <Trash2 size={13} />
      </button>
    </div>
  )
}
