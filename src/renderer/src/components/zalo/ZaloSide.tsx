import { useEffect, useState } from 'react'
import { ChevronRight, ClipboardList } from 'lucide-react'
import type { ZaloTask, ZaloTasksState } from '../../../../shared/types'
import { useStore } from '../../store'
import { Collapse } from '../motion'
import { Avatar } from './Avatar'
import { listTime } from './util'
import { useT } from '../../i18n'

const KEY = 'side.zaloOpen'
const ORDER: Record<ZaloTask['status'], number> = { todo: 0, doing: 1, done: 2 }

/**
 * Sidebar group under the agents: my unfinished Zalo tasks (open by default).
 * Click a task → the Zalo tab. Hidden until Zalo is logged in or there are tasks.
 */
export function ZaloSideGroup({ filter }: { filter: string }): React.JSX.Element | null {
  const t = useT()
  const [s, setS] = useState<ZaloTasksState>({ tasks: [], running: false, analyzedAt: 0 })
  const [online, setOnline] = useState(false)
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== '0'
    } catch {
      return true
    }
  })

  useEffect(() => {
    // a push that beats the first fetch is newer: the fetch must not overwrite it
    let pushed = false
    void window.api.zalo.tasks().then((st) => !pushed && setS(st))
    void window.api.zalo.state().then((z) => setOnline(z.status === 'online'))
    const offT = window.api.zalo.onTasks((st) => {
      pushed = true
      setS(st)
    })
    const offS = window.api.zalo.onState((z) => setOnline(z.status === 'online'))
    return () => {
      offT()
      offS()
    }
  }, [])

  const toggle = (): void => {
    setOpen((v) => {
      try {
        localStorage.setItem(KEY, v ? '0' : '1')
      } catch {
        /* private mode */
      }
      return !v
    })
  }

  const needle = filter.trim().toLowerCase()
  const rows = s.tasks
    .filter((t) => t.status !== 'done')
    .filter((t) => !needle || `${t.title} ${t.from} ${t.threadName}`.toLowerCase().includes(needle))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.ts - a.ts)
  const pending = s.tasks.filter((t) => t.status !== 'done').length
  if (!online && !s.tasks.length) return null
  if (needle && !rows.length) return null
  const show = needle ? true : open
  const goto = (): void => useStore.setState({ centerView: 'zalo' })

  return (
    <div className="proj agent-group zs-group">
      <div className="proj-row" onClick={toggle} title={t('My tasks on Zalo', 'Việc của tôi trên Zalo')}>
        <span className="proj-name">Zalo</span>
        <ChevronRight size={13} className={`proj-chev${show ? ' open' : ''}`} />
        {s.running && <span className="proj-live" title={t('Claude is reading messages', 'Claude đang đọc tin nhắn')} />}
        <span className="proj-spacer" />
        {pending > 0 && (
          <span className="zs-count" title={t(`${pending} unfinished ${pending === 1 ? 'task' : 'tasks'}`, `${pending} việc chưa xong`)}>
            {pending > 99 ? '99+' : pending}
          </span>
        )}
        <button
          className="icon-btn tiny proj-add"
          title={t('Open My tasks', 'Mở Việc của tôi')}
          onClick={(e) => {
            e.stopPropagation()
            goto()
          }}
        >
          <ClipboardList size={13} />
        </button>
      </div>
      <Collapse open={show}>
        {rows.length === 0 && <div className="sess-empty">{t('No unfinished tasks', 'Không có việc nào chưa xong')}</div>}
        {rows.map((task) => (
          <div
            key={task.id}
            className={`sess-row zs-row ${task.status}`}
            onClick={goto}
            title={`${task.title}\n${task.group ? `${task.threadName} · ` : ''}${task.from} · ${task.status === 'todo' ? t('To do', 'Cần làm') : t('In progress', 'Đang xử lý')}`}
          >
            <span className="zs-av">
              <Avatar id={task.fromId ?? task.threadId} name={task.from} src={task.avatar} size={18} />
              <i className="zs-dot" />
            </span>
            <span className="sess-title">{task.title}</span>
            {s.unseen?.[task.id] && <span className="zs-new" title={s.unseen[task.id] === 'new' ? t('New task', 'Việc mới') : t('Just updated', 'Vừa cập nhật')} />}
            <span className="sess-time">{listTime(task.ts, t)}</span>
          </div>
        ))}
      </Collapse>
    </div>
  )
}
