import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, CircleDot, ClipboardList, Loader2, RefreshCw, Sparkles, Trash2, Users } from 'lucide-react'
import type { ZaloTask, ZaloTasksState } from '../../../../shared/types'
import { listTime } from './util'

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

  useEffect(() => {
    void window.api.zalo.tasks().then((st) => {
      setS(st)
      // first look of the day: refresh once on its own
      if (!st.running && Date.now() - st.analyzedAt > 30 * 60_000) void window.api.zalo.analyzeTasks()
    })
    return window.api.zalo.onTasks(setS)
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
      <div className="zt-body">
        {s.tasks.length === 0 && (
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
              {!folded && list.map((t) => <Row key={t.id} t={t} />)}
            </section>
          )
        })}
      </div>
      <div className="zt-foot">Trả lời trên Zalo điện thoại — tin của bạn đồng bộ về và việc tự chuyển trạng thái.</div>
    </div>
  )
}

function Row({ t }: { t: ZaloTask }): React.JSX.Element {
  return (
    <div className={'zt-row ' + t.status}>
      <button
        className="zt-check"
        title={t.status === 'todo' ? 'Đánh dấu đang xử lý' : t.status === 'doing' ? 'Đánh dấu hoàn thành' : 'Mở lại'}
        onClick={() => void window.api.zalo.setTaskStatus(t.id, NEXT[t.status])}
      >
        {t.status === 'done' ? <Check size={13} /> : t.status === 'doing' ? <CircleDot size={13} /> : null}
      </button>
      <div className="zt-main">
        <span className="zt-row-title">{t.title}</span>
        {t.detail && <span className="zt-row-detail">{t.detail}</span>}
        <span className="zt-row-meta">
          {t.group && <Users size={11} />}
          {t.group ? `${t.threadName} · ${t.from}` : t.from} · {listTime(t.ts)}
          {t.manual && <span className="zt-manual">· đặt tay</span>}
        </span>
      </div>
      <button className="zt-del" title="Xoá khỏi danh sách" onClick={() => void window.api.zalo.removeTask(t.id)}>
        <Trash2 size={13} />
      </button>
    </div>
  )
}
