import { useEffect, useState } from 'react'
import { ChevronRight, CircleCheck, CircleX, Loader } from 'lucide-react'
import type { ChatTask } from '../../../shared/types'
import { useT, type T } from '../i18n'

/** A chat's background tasks, reloaded as the transcript changes and every few seconds while one runs. */
export function useChatTasks(sessionId: string | undefined): ChatTask[] {
  const [tasks, setTasks] = useState<ChatTask[]>([])
  useEffect(() => {
    setTasks([])
    if (!sessionId || typeof window.api.sessions.tasks !== 'function') return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const load = (): void => {
      window.api.sessions
        .tasks(sessionId)
        .then((list) => {
          if (!alive) return
          // same list (a poll while nothing changed): no re-render
          setTasks((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list))
          // running ones write output without touching the transcript: keep looking
          clearInterval(poll)
          if (list.some((t) => t.status === 'running')) poll = setInterval(load, 3000)
        })
        .catch(() => {})
    }
    load()
    const off = window.api.sessions.onChanged((ids) => {
      if (!ids.includes(sessionId) && !ids.includes('*')) return
      clearTimeout(timer)
      timer = setTimeout(load, 700)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(poll)
      off()
    }
  }, [sessionId])
  return tasks
}

function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const took = (task: ChatTask, t: T): string =>
  task.endedAt ? dur(task.endedAt - task.startedAt) : t(`running ${dur(Date.now() - task.startedAt)}`, `đang chạy ${dur(Date.now() - task.startedAt)}`)

export function ChatTasks({ tasks }: { tasks: ChatTask[] }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState<string | null>(null)
  // "running 4s" is computed at render: tick while something runs, or it stays frozen
  const [, tick] = useState(0)
  const anyRunning = tasks.some((task) => task.status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const i = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(i)
  }, [anyRunning])
  if (!tasks.length) return <div className="chat-tasks"><div className="chat-images-empty">{t('No background tasks in this chat yet. When Claude runs something in the background (a build, a dev server…), it shows up here.', 'Chat này chưa có việc chạy nền nào. Khi Claude chạy gì đó trong nền (build, dev server…), nó sẽ hiện ở đây.')}</div></div>
  return (
    <div className="chat-tasks">
      {tasks.map((task) => {
        const ok = task.status === 'completed'
        const running = task.status === 'running'
        const expanded = open === task.id || (open === null && running)
        return (
          <div key={task.id} className={`task-card s-${running ? 'running' : ok ? 'ok' : 'fail'}`}>
            <button className="task-head" onClick={() => setOpen(expanded ? '' : task.id)}>
              <ChevronRight size={13} className={expanded ? 'task-chev open' : 'task-chev'} />
              {running ? <Loader size={14} className="task-spin" /> : ok ? <CircleCheck size={14} /> : <CircleX size={14} />}
              <span className="task-title">{task.description || task.command}</span>
              <span className="task-time">{took(task, t)}</span>
            </button>
            {expanded && (
              <div className="task-body">
                {task.description && <code className="task-cmd">{task.command}</code>}
                <pre className="task-out">{task.output?.trim() || (running ? t('No output yet…', 'Chưa có output…') : t('No output.', 'Không có output.'))}</pre>
                <div className="task-meta">
                  {task.id} · {task.status}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
