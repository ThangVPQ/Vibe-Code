import { useEffect, useRef, useState } from 'react'
import { History, Loader2, LogOut, MessageCircle, QrCode, RefreshCw, Search, Send, TriangleAlert, Users, X } from 'lucide-react'
import type { ZaloMessage, ZaloState, ZaloThread } from '../../../shared/types'

const errText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

function timeLabel(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date()
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

/** Zalo tab: QR login, then conversations on the left and the open one on the right. */
export function ZaloPane(): React.JSX.Element {
  const [state, setState] = useState<ZaloState>({ status: 'off' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    void window.api.zalo.state().then(setState)
    const offS = window.api.zalo.onState(setState)
    const offC = window.api.zalo.onChanged(() => setTick((t) => t + 1))
    return () => {
      offS()
      offC()
    }
  }, [])

  if (state.status !== 'online') return <ZaloLogin state={state} />
  return <ZaloChats state={state} tick={tick} />
}

function ZaloLogin({ state }: { state: ZaloState }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const start = (): void => {
    setBusy(true)
    void window.api.zalo.login().finally(() => setBusy(false))
  }
  return (
    <div className="zalo-login">
      <div className="zalo-card">
        <div className="zalo-title">
          <MessageCircle size={22} /> Zalo
        </div>
        {state.status === 'connecting' && (
          <p className="zalo-dim">
            <Loader2 size={14} className="spin" /> Đang kết nối lại phiên đã lưu…
          </p>
        )}
        {state.status === 'qr' && state.qr && (
          <>
            <img className="zalo-qr" src={state.qr} alt="Mã QR đăng nhập Zalo" />
            <p className="zalo-dim">{state.scanned ? `${state.scanned} đã quét — bấm Đăng nhập trên điện thoại.` : 'Mở Zalo trên điện thoại → Quét mã QR.'}</p>
            <button className="btn btn-ghost btn-sm" onClick={() => void window.api.zalo.cancel()}>
              <X size={14} /> Huỷ
            </button>
          </>
        )}
        {state.status === 'qr' && !state.qr && !state.error && (
          <p className="zalo-dim">
            <Loader2 size={14} className="spin" /> Đang lấy mã QR…
          </p>
        )}
        {state.error && <p className="zalo-error">{state.error}</p>}
        {(state.status === 'off' || state.status === 'error' || (state.status === 'qr' && !state.qr && state.error)) && (
          <div className="zalo-actions">
            <button className="btn btn-primary" disabled={busy} onClick={start}>
              <QrCode size={15} /> Đăng nhập bằng QR
            </button>
            {state.status === 'error' && (
              <button className="btn btn-ghost" onClick={() => void window.api.zalo.reconnect()}>
                <RefreshCw size={14} /> Kết nối lại
              </button>
            )}
          </div>
        )}
        <p className="zalo-warn">
          <TriangleAlert size={13} /> Dùng API không chính thức (zca-js), giống cách Zalo Web hoạt động. Zalo có thể khoá tài khoản vì việc này. Mỗi tài khoản chỉ
          giữ được một phiên web: mở chat.zalo.me ở nơi khác thì phiên ở đây sẽ bị ngắt.
        </p>
      </div>
    </div>
  )
}

function ZaloChats({ state, tick }: { state: ZaloState; tick: number }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<ZaloThread[]>([])
  const [active, setActive] = useState<ZaloThread | null>(null)
  const [msgs, setMsgs] = useState<ZaloMessage[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    void window.api.zalo.threads(query).then(setThreads)
  }, [query, tick])

  useEffect(() => {
    if (!active) return
    void window.api.zalo.messages(active.id, 500).then(setMsgs)
  }, [active, tick])

  // keep the view at the bottom while the user is there
  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [msgs])

  const open = (t: ZaloThread): void => {
    stick.current = true
    setError('')
    setActive(t)
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || !active) return
    setError('')
    try {
      await window.api.zalo.send(active.id, text)
      setDraft('')
      stick.current = true
    } catch (e) {
      setError(errText(e))
    }
  }

  const older = async (): Promise<void> => {
    if (!active) return
    setLoadingOlder(true)
    stick.current = false
    try {
      await window.api.zalo.loadOlder(active.id)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoadingOlder(false)
    }
  }

  return (
    <div className="zalo-pane">
      <div className="zalo-side">
        <div className="zalo-me">
          {state.self?.avatar ? <img src={state.self.avatar} alt="" /> : <MessageCircle size={18} />}
          <span className="zalo-me-name">{state.self?.name || 'Zalo'}</span>
          <button
            className="icon-btn"
            title="Đăng xuất và xoá dữ liệu Zalo đã lưu"
            onClick={() => {
              if (window.confirm('Đăng xuất Zalo và xoá toàn bộ tin nhắn đã đồng bộ trên máy này?')) void window.api.zalo.logout()
            }}
          >
            <LogOut size={14} />
          </button>
        </div>
        <label className="zalo-search">
          <Search size={13} />
          <input placeholder="Tìm cuộc trò chuyện" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="zalo-threads">
          {threads.length === 0 && <p className="zalo-dim zalo-pad">Đang đồng bộ tin nhắn…</p>}
          {threads.map((t) => (
            <button key={t.id} className={'zalo-thread' + (active?.id === t.id ? ' on' : '')} onClick={() => open(t)}>
              <span className="zalo-thread-icon">{t.group ? <Users size={14} /> : <MessageCircle size={14} />}</span>
              <span className="zalo-thread-body">
                <span className="zalo-thread-top">
                  <span className="zalo-thread-name">{t.name || t.id}</span>
                  <span className="zalo-thread-time">{timeLabel(t.lastTs)}</span>
                </span>
                <span className="zalo-thread-last">{t.last || ' '}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="zalo-main">
        {!active ? (
          <div className="zalo-empty">
            <MessageCircle size={28} />
            <p>Chọn một cuộc trò chuyện. Claude cũng đọc được các tin nhắn này qua tool zalo_* trong chat.</p>
          </div>
        ) : (
          <>
            <div className="zalo-head">
              {active.group ? <Users size={15} /> : <MessageCircle size={15} />}
              <span className="zalo-head-name">{active.name || active.id}</span>
              <span className="zalo-dim zalo-head-id">{active.id}</span>
              {active.group && (
                <button className="btn btn-ghost btn-sm" disabled={loadingOlder} onClick={() => void older()}>
                  {loadingOlder ? <Loader2 size={13} className="spin" /> : <History size={13} />} Tải tin cũ hơn
                </button>
              )}
            </div>
            <div
              className="zalo-msgs"
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}
            >
              {msgs.length === 0 && <p className="zalo-dim zalo-pad">Chưa có tin nhắn nào được đồng bộ cho cuộc trò chuyện này.</p>}
              {msgs.map((m, i) => {
                const showName = active.group && !m.self && msgs[i - 1]?.fromId !== m.fromId
                return (
                  <div key={m.id} className={'zalo-msg' + (m.self ? ' self' : '')}>
                    {showName && <div className="zalo-msg-from">{m.fromName}</div>}
                    <div className="zalo-bubble" title={new Date(m.ts).toLocaleString('vi-VN')}>
                      {m.quote && <div className="zalo-quote">{m.quote}</div>}
                      <span className="zalo-text">{m.text}</span>
                      <span className="zalo-time">{timeLabel(m.ts)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
            {error && <div className="zalo-error zalo-pad">{error}</div>}
            <div className="zalo-compose">
              <textarea
                rows={1}
                placeholder={`Nhắn tới ${active.name || active.id}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={() => void send()}>
                <Send size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
