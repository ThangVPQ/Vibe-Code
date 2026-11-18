import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, BellOff, Check, CheckCheck, Loader2, LogOut, Menu, Pin, QrCode, RefreshCw, Search, TriangleAlert, Users, WifiOff, X } from 'lucide-react'
import type { ZaloState, ZaloThread, ZaloTyping } from '../../../shared/types'
import { ZaloChat } from './zalo/ZaloChat'
import { Avatar, TypingDots } from './zalo/Avatar'
import { listTime } from './zalo/util'
import './zalo/zalo.css'

type Filter = 'all' | 'unread' | 'personal' | 'group' | 'contacts'
const FILTERS: [Filter, string][] = [
  ['all', 'Tất cả'],
  ['unread', 'Chưa đọc'],
  ['personal', 'Cá nhân'],
  ['group', 'Nhóm'],
  ['contacts', 'Danh bạ']
]

/** Zalo tab: QR login, then a Telegram-style messenger — chat list on the left, the open chat on the right. */
export function ZaloPane(): React.JSX.Element {
  const [state, setState] = useState<ZaloState>({ status: 'off' })
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void window.api.zalo.state().then((s) => {
      setState(s)
      setLoaded(true)
    })
    return window.api.zalo.onState(setState)
  }, [])
  if (!loaded) return <div className="zl-login" />
  // keep the chats on screen while (re)connecting, like Telegram's "Connecting…"
  if (state.status === 'off' || state.status === 'qr' || (!state.self && state.status !== 'connecting')) return <ZaloLogin state={state} />
  return <ZaloMessenger state={state} />
}

/** Total unread, for the Zalo tab's badge. */
export function useZaloUnread(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const load = (): void => void window.api.zalo.uiThreads().then((list) => setN(list.reduce((s, t) => s + (t.unread ?? 0), 0)))
    load()
    return window.api.zalo.onChanged(load)
  }, [])
  return n
}

/* ================================ login ================================ */

function ZaloLogin({ state }: { state: ZaloState }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const start = (): void => {
    setBusy(true)
    void window.api.zalo.login().finally(() => setBusy(false))
  }
  const waitingQr = state.status === 'qr' && !state.qr && !state.error
  return (
    <div className="zl-login">
      <div className="zl-login-card">
        {state.status === 'qr' && state.qr ? (
          <>
            <div className={'zl-qr' + (state.scanned ? ' scanned' : '')}>
              <img src={state.qr} alt="Mã QR đăng nhập Zalo" />
              {state.scanned && (
                <div className="zl-qr-done">
                  <Check size={34} />
                </div>
              )}
            </div>
            <h2>{state.scanned ? `Xin chào, ${state.scanned}` : 'Đăng nhập Zalo bằng mã QR'}</h2>
            {state.scanned ? (
              <p className="zl-login-sub">Bấm “Đăng nhập” trên điện thoại để hoàn tất.</p>
            ) : (
              <ol className="zl-steps">
                <li>Mở Zalo trên điện thoại</li>
                <li>
                  Bấm biểu tượng <QrCode size={13} /> cạnh ô tìm kiếm
                </li>
                <li>Hướng camera vào mã này để quét</li>
              </ol>
            )}
            <button className="zl-link-btn" onClick={() => void window.api.zalo.cancel()}>
              Huỷ
            </button>
          </>
        ) : (
          <>
            <div className="zl-logo">
              <span>Zalo</span>
            </div>
            <h2>Zalo trong VIBE CODE</h2>
            <p className="zl-login-sub">Nhắn tin bằng tài khoản Zalo cá nhân ngay cạnh code. Claude đọc được các cuộc trò chuyện qua tool zalo_*.</p>
            {(waitingQr || state.status === 'connecting') && (
              <p className="zl-login-sub">
                <Loader2 size={14} className="zl-spin" /> {state.status === 'connecting' ? 'Đang kết nối lại phiên đã lưu…' : 'Đang lấy mã QR…'}
              </p>
            )}
            {state.error && <p className="zl-login-error">{state.error}</p>}
            {!waitingQr && state.status !== 'connecting' && (
              <div className="zl-login-actions">
                <button className="zl-primary" disabled={busy} onClick={start}>
                  <QrCode size={16} /> Đăng nhập bằng QR
                </button>
                {state.status === 'error' && (
                  <button className="zl-secondary" onClick={() => void window.api.zalo.reconnect()}>
                    <RefreshCw size={14} /> Kết nối lại
                  </button>
                )}
              </div>
            )}
          </>
        )}
        <p className="zl-login-warn">
          <TriangleAlert size={13} /> Dùng API không chính thức (zca-js), giống cách Zalo Web hoạt động; Zalo có thể khoá tài khoản vì việc này. Mỗi tài khoản chỉ giữ một
          phiên web: mở chat.zalo.me ở nơi khác thì phiên ở đây bị ngắt.
        </p>
      </div>
    </div>
  )
}

/* ================================ messenger ================================ */

function ZaloMessenger({ state }: { state: ZaloState }): React.JSX.Element {
  const [threads, setThreads] = useState<ZaloThread[]>([])
  const [contacts, setContacts] = useState<ZaloThread[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  /** a friend opened from the contact list before any message exists */
  const [extra, setExtra] = useState<ZaloThread | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [typing, setTyping] = useState<Record<string, ZaloTyping & { until: number }>>({})
  const [changedIds, setChangedIds] = useState<{ ids: string[]; n: number }>({ ids: [], n: 0 })
  const [menu, setMenu] = useState(false)
  const [notify, setNotify] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const load = (): void => void window.api.zalo.uiThreads().then(setThreads)
    load()
    void window.api.zalo.prefs().then((p) => setNotify(p.notify))
    const offC = window.api.zalo.onChanged((ids) => {
      load()
      setChangedIds((c) => ({ ids, n: c.n + 1 }))
    })
    const offT = window.api.zalo.onTyping((t) =>
      setTyping((m) => ({ ...m, [t.threadId]: { ...t, until: Date.now() + 6000 } }))
    )
    const offO = window.api.zalo.onOpenThread((id) => setActiveId(id))
    return () => {
      offC()
      offT()
      offO()
    }
  }, [])

  // typing indicators fade out on their own
  useEffect(() => {
    const ids = Object.keys(typing)
    if (!ids.length) return
    const next = Math.min(...ids.map((k) => typing[k].until)) - Date.now()
    const t = setTimeout(() => setTyping((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v.until > Date.now()))), Math.max(50, next))
    return () => clearTimeout(t)
  }, [typing])

  useEffect(() => {
    if (filter === 'contacts') void window.api.zalo.contacts().then(setContacts)
  }, [filter, changedIds.n])

  // the open conversation counts as read; tell the main process which one it is
  useEffect(() => {
    void window.api.zalo.setActive(activeId)
    return () => void window.api.zalo.setActive(null)
  }, [activeId])

  const active = useMemo(() => threads.find((t) => t.id === activeId) ?? (extra?.id === activeId ? extra : null), [threads, activeId, extra])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = filter === 'contacts' ? contacts : threads
    return pool.filter((t) => {
      if (q && !t.name.toLowerCase().includes(q) && !t.id.includes(q)) return false
      if (filter === 'unread') return !!t.unread
      if (filter === 'personal') return !t.group
      if (filter === 'group') return t.group
      return true
    })
  }, [threads, contacts, filter, query])

  const counts = useMemo(
    () => ({
      all: threads.filter((t) => t.unread).length,
      unread: threads.filter((t) => t.unread).length,
      personal: threads.filter((t) => !t.group && t.unread).length,
      group: threads.filter((t) => t.group && t.unread).length,
      contacts: 0
    }),
    [threads]
  )

  const open = (t: ZaloThread): void => {
    if (t.contact) setExtra(t)
    setActiveId(t.id)
  }

  const offline = state.status !== 'online'

  return (
    <div className="zl-pane" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
      <aside className="zl-side">
        <div className="zl-side-top">
          <button className={'zl-icon' + (menu ? ' on' : '')} title="Menu" onClick={() => setMenu((m) => !m)}>
            <Menu size={19} />
          </button>
          <label className="zl-search">
            <Search size={15} />
            <input
              ref={searchRef}
              placeholder="Tìm kiếm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
                if (e.key === 'Enter' && shown[0]) open(shown[0])
              }}
            />
            {query && (
              <button className="zl-search-clear" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )}
          </label>
          <button
            className="zl-icon"
            title="Đồng bộ tất cả cuộc trò chuyện"
            disabled={offline || syncing}
            onClick={() => {
              setSyncing(true)
              void window.api.zalo.syncAll().finally(() => setSyncing(false))
            }}
          >
            <RefreshCw size={17} className={syncing ? 'zl-spin' : undefined} />
          </button>
          {menu && (
            <>
              <div className="zl-scrim" onClick={() => setMenu(false)} />
              <div className="zl-menu">
                <div className="zl-menu-me">
                  <Avatar id={state.self?.id ?? 'me'} name={state.self?.name ?? 'Tôi'} src={state.self?.avatar} size={46} />
                  <div>
                    <div className="zl-menu-name">{state.self?.name || 'Zalo'}</div>
                    <div className="zl-menu-sub">{offline ? 'Đang ngoại tuyến' : 'Đang hoạt động'}</div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    const v = !notify
                    setNotify(v)
                    void window.api.zalo.prefs({ notify: v })
                  }}
                >
                  {notify ? <Bell size={16} /> : <BellOff size={16} />} Thông báo tin nhắn mới
                  <span className={'zl-switch' + (notify ? ' on' : '')} />
                </button>
                <button
                  onClick={() => {
                    setMenu(false)
                    void window.api.zalo.reconnect()
                  }}
                >
                  <RefreshCw size={16} /> Kết nối lại
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setMenu(false)
                    if (window.confirm('Đăng xuất Zalo và xoá toàn bộ tin nhắn đã đồng bộ trên máy này?')) void window.api.zalo.logout()
                  }}
                >
                  <LogOut size={16} /> Đăng xuất
                </button>
              </div>
            </>
          )}
        </div>
        {offline && <ConnBanner state={state} />}
        <div className="zl-filters" role="tablist">
          {FILTERS.map(([k, label]) => (
            <button key={k} role="tab" className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {label}
              {k !== 'all' && counts[k] > 0 && <span className="zl-filter-n">{counts[k]}</span>}
            </button>
          ))}
        </div>
        <div className="zl-list">
          {shown.length === 0 && (
            <div className="zl-list-empty">{query ? 'Không tìm thấy cuộc trò chuyện.' : filter === 'unread' ? 'Không có tin nhắn chưa đọc 🎉' : 'Đang đồng bộ…'}</div>
          )}
          {shown.map((t) => (
            <ThreadRow
              key={t.id}
              t={t}
              on={t.id === activeId}
              draft={t.id !== activeId ? drafts[t.id] : undefined}
              typing={typing[t.id]}
              contact={filter === 'contacts'}
              onClick={() => open(t)}
            />
          ))}
        </div>
      </aside>
      <main className="zl-main">
        {active ? (
          <ZaloChat
            key={active.id}
            thread={active}
            self={state.self}
            online={!offline}
            changed={changedIds}
            typing={typing[active.id]}
            draft={drafts[active.id] ?? ''}
            setDraft={(v) => setDrafts((d) => ({ ...d, [active.id]: v }))}
            threads={threads}
            onClose={() => setActiveId(null)}
          />
        ) : (
          <div className="zl-wall zl-nochat">
            <span>Chọn một cuộc trò chuyện để bắt đầu nhắn tin</span>
          </div>
        )}
      </main>
    </div>
  )
}

function ConnBanner({ state }: { state: ZaloState }): React.JSX.Element {
  if (state.status === 'connecting')
    return (
      <div className="zl-conn">
        <Loader2 size={14} className="zl-spin" /> Đang kết nối…
      </div>
    )
  return (
    <div className="zl-conn err">
      <WifiOff size={14} />
      <span>{state.error || 'Mất kết nối'}</span>
      <button onClick={() => void window.api.zalo.reconnect()}>Kết nối lại</button>
      <button onClick={() => void window.api.zalo.login()}>QR</button>
    </div>
  )
}

function ThreadRow({
  t,
  on,
  draft,
  typing,
  contact,
  onClick
}: {
  t: ZaloThread
  on: boolean
  draft?: string
  typing?: ZaloTyping
  contact: boolean
  onClick: () => void
}): React.JSX.Element {
  const name = t.name || t.id
  let preview: React.ReactNode
  if (typing) preview = <span className="zl-row-typing">{t.group && typing.name ? `${typing.name} đang soạn tin` : 'đang soạn tin'}<TypingDots /></span>
  else if (draft?.trim()) preview = (
    <>
      <span className="zl-row-draft">Bản nháp: </span>
      {draft}
    </>
  )
  else if (contact && !t.lastTs) preview = <span className="zl-dim">Bạn bè</span>
  else if (!t.last) preview = <span className="zl-dim">{t.group ? `${t.members ? t.members + ' thành viên' : 'Nhóm'}` : 'Chưa có tin nhắn'}</span>
  else {
    const i = t.last.indexOf(': ')
    const who = t.lastSelf ? 'Bạn' : t.group && i > 0 && i < 40 ? t.last.slice(0, i) : ''
    const body = t.group && !t.lastSelf && i > 0 && i < 40 ? t.last.slice(i + 2) : t.last
    preview = (
      <>
        {who && <span className="zl-row-who">{who}: </span>}
        {body}
      </>
    )
  }
  return (
    <button className={'zl-row' + (on ? ' on' : '')} onClick={onClick}>
      <Avatar id={t.id} name={name} src={t.avatar} size={50} group={t.group} />
      <span className="zl-row-body">
        <span className="zl-row-top">
          <span className="zl-row-name">
            {t.group && <Users size={13} className="zl-row-gi" />}
            <span>{name}</span>
          </span>
          {t.lastSelf && t.lastStatus && (
            <span className="zl-row-tick">{t.lastStatus === 'seen' ? <CheckCheck size={15} /> : <Check size={15} />}</span>
          )}
          <span className="zl-row-time">{listTime(t.lastTs)}</span>
        </span>
        <span className="zl-row-bottom">
          <span className="zl-row-last">{preview}</span>
          {t.unread ? <span className="zl-badge">{t.unread > 99 ? '99+' : t.unread}</span> : t.pinned ? <Pin size={14} className="zl-row-pin" /> : null}
        </span>
      </span>
    </button>
  )
}
