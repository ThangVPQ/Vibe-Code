import { useEffect, useState } from 'react'
import { ExternalLink, Loader2, LogOut, Mail, Paperclip, RefreshCw, TriangleAlert } from 'lucide-react'
import type { MailBody, MailSummary } from '../../../shared/types'
import { TaskMenu } from './zalo/ZaloTasks'
import { newChatFromMail } from '../actions'
import './zalo/zalo.css'
import './gmail.css'

const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords'
/** must match PAGE_SIZE in gmail.rs: a shorter page means the inbox has no older mail */
const PAGE_SIZE = 30

/** Gmail tab: sign in with an app password, then a read-only inbox (list on the left, message on the right). */
export function GmailPane(): React.JSX.Element {
  const [email, setEmail] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    void window.api.gmail.state().then(setEmail)
  }, [])
  if (email === undefined) return <div className="gm-root" />
  if (!email) return <GmailLogin onDone={setEmail} />
  return <GmailInbox email={email} onLogout={() => setEmail(null)} />
}

/* ================================ login ================================ */

function GmailLogin({ onDone }: { onDone: (email: string) => void }): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    setBusy(true)
    setError('')
    window.api.gmail
      .login(email, password)
      .then(onDone)
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="gm-root gm-login">
      <form className="gm-login-card" onSubmit={submit}>
        <div className="gm-logo">
          <Mail size={40} />
        </div>
        <h2>Gmail trong VIBE CODE</h2>
        <p className="gm-dim">Xem hộp thư đến ngay trong app. Chỉ đọc: không gửi thư, không đánh dấu đã đọc.</p>
        <input type="email" placeholder="ban@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        <input type="password" placeholder="Mật khẩu ứng dụng (16 ký tự)" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="gm-error">{error}</p>}
        <button className="gm-primary" type="submit" disabled={busy}>
          {busy ? <Loader2 size={16} className="gm-spin" /> : <Mail size={16} />} Đăng nhập
        </button>
        <ol className="gm-steps">
          <li>Bật Xác minh 2 bước cho tài khoản Google.</li>
          <li>
            Tạo mật khẩu ứng dụng tại{' '}
            <a
              href={APP_PASSWORDS}
              onClick={(e) => {
                e.preventDefault()
                void window.api.app.openExternal(APP_PASSWORDS)
              }}
            >
              myaccount.google.com/apppasswords <ExternalLink size={11} />
            </a>
          </li>
          <li>Dán mật khẩu 16 ký tự đó vào ô trên (không phải mật khẩu Google thường).</li>
        </ol>
        <p className="gm-warn">
          <TriangleAlert size={13} /> Mật khẩu ứng dụng được mã hoá và chỉ lưu trên máy này.
        </p>
      </form>
    </div>
  )
}

/* ================================ inbox ================================ */

function GmailInbox({ email, onLogout }: { email: string; onLogout: () => void }): React.JSX.Element {
  const [list, setList] = useState<MailSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [openUid, setOpenUid] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  /** right-click on a mail: pick a project, then a coding chat starts with the email as context */
  const [menu, setMenu] = useState<{ m: MailSummary; x: number; y: number } | null>(null)
  const [preparing, setPreparing] = useState<string | null>(null)
  const startChat = async (m: MailSummary, cwd: string | null): Promise<void> => {
    setPreparing(m.subject || '(không có tiêu đề)')
    try {
      await newChatFromMail(m.uid, m.subject, cwd)
    } catch (e) {
      window.alert('Không tạo được chat: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setPreparing(null)
    }
  }
  const refresh = (): void => {
    setLoading(true)
    setError('')
    window.api.gmail
      .list()
      .then((page) => {
        setList(page)
        setHasMore(page.length >= PAGE_SIZE)
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false))
  }
  /** next page of older mail, when the list is scrolled near its bottom */
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (!list?.length || !hasMore || loading || loadingMore || el.scrollTop + el.clientHeight < el.scrollHeight - 200) return
    setLoadingMore(true)
    window.api.gmail
      .list(list[list.length - 1].uid)
      .then((page) => {
        setList((cur) => [...(cur ?? []), ...page])
        setHasMore(page.length >= PAGE_SIZE)
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoadingMore(false))
  }
  useEffect(refresh, [])
  const unread = list?.filter((m) => !m.seen).length ?? 0
  return (
    <div className="gm-root gm-inbox">
      <div className="gm-side">
        <div className="gm-head">
          <div className="gm-head-info">
            <div className="gm-head-title">
              Hộp thư đến{unread > 0 && <span className="gm-badge">{unread}</span>}
            </div>
            <div className="gm-email" title={email}>
              {email}
            </div>
          </div>
          <button className="gm-icon" title="Tải lại" disabled={loading || loadingMore} onClick={refresh}>
            <RefreshCw size={15} className={loading ? 'gm-spin' : undefined} />
          </button>
          <button
            className="gm-icon"
            title="Đăng xuất"
            onClick={() => {
              void window.api.ask('Đăng xuất Gmail và xoá mật khẩu ứng dụng đã lưu trên máy này?').then((ok) => (ok ? window.api.gmail.logout().then(onLogout) : undefined))
            }}
          >
            <LogOut size={15} />
          </button>
        </div>
        {loading && list !== null && <div className="gm-progress" />}
        {error && <p className="gm-error gm-pad">{error}</p>}
        {preparing && (
          <p className="gm-dim gm-pad">
            <Loader2 size={13} className="gm-spin" /> Đang lấy thư và tệp đính kèm cho chat mới: {preparing}
          </p>
        )}
        {list?.length === 0 && <p className="gm-dim gm-pad">Hộp thư đến trống.</p>}
        <div className="gm-list" onScroll={onScroll}>
          {list === null && !error && Array.from({ length: 8 }, (_, i) => <div key={i} className="gm-row gm-skeleton" />)}
          {list?.map((m) => (
            <button
              key={m.uid}
              className={'gm-row' + (m.seen ? '' : ' unread') + (m.uid === openUid ? ' on' : '')}
              title={`${m.from} <${m.fromAddr}>\n${m.subject}`}
              onClick={() => setOpenUid(m.uid)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ m, x: e.clientX, y: e.clientY })
              }}
            >
              <Initial name={m.from} />
              <div className="gm-row-main">
                <div className="gm-row-top">
                  <span className="gm-from">{m.from}</span>
                  <span className="gm-date">{shortDate(m.date)}</span>
                </div>
                <div className="gm-subject">{m.subject || '(không có tiêu đề)'}</div>
              </div>
            </button>
          ))}
          {loadingMore && (
            <div className="gm-empty gm-pad">
              <Loader2 size={18} className="gm-spin" />
            </div>
          )}
        </div>
      </div>
      <div className="gm-reader">
        {openUid === null ? (
          <div className="gm-empty">
            <Mail size={36} />
            <p className="gm-dim">Chọn một thư để đọc</p>
          </div>
        ) : (
          <MailView key={openUid} uid={openUid} />
        )}
      </div>
      {menu && <TaskMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} onChat={(cwd) => void startChat(menu.m, cwd)} />}
    </div>
  )
}

function MailView({ uid }: { uid: number }): React.JSX.Element {
  const [mail, setMail] = useState<MailBody | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    window.api.gmail
      .read(uid)
      .then(setMail)
      .catch((err: unknown) => setError(String(err)))
  }, [uid])
  if (error) return <p className="gm-error gm-pad">{error}</p>
  if (!mail)
    return (
      <div className="gm-empty">
        <Loader2 size={22} className="gm-spin" />
        <p className="gm-dim">Đang mở thư…</p>
      </div>
    )
  const sender = splitAddress(mail.from)
  return (
    <div className="gm-mail">
      <div className="gm-mail-head">
        <h2>{mail.subject || '(không có tiêu đề)'}</h2>
        <div className="gm-sender">
          <Initial name={sender.name} size={40} />
          <div className="gm-sender-info">
            <div className="gm-sender-line">
              <b>{sender.name}</b>
              {sender.addr && sender.addr !== sender.name && <span className="gm-dim">&lt;{sender.addr}&gt;</span>}
            </div>
            <div className="gm-dim">tới {mail.to}</div>
          </div>
          <div className="gm-mail-date">{mail.date ? new Date(mail.date).toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }) : ''}</div>
        </div>
        {mail.attachments.length > 0 && (
          <div className="gm-attach">
            {mail.attachments.map((a, i) => (
              <span key={i} className="gm-chip" title={a}>
                <Paperclip size={12} /> {a}
              </span>
            ))}
          </div>
        )}
      </div>
      {mail.html ? <MailFrame html={mail.html} /> : <pre className="gm-text">{mail.text ?? '(thư không có nội dung)'}</pre>}
    </div>
  )
}

/** Round badge with the sender's first letter, colored from the name so each sender keeps one color. */
function Initial({ name, size = 34 }: { name: string; size?: number }): React.JSX.Element {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return (
    <span className="gm-initial" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${h} 55% 45%)` }}>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

/**
 * The email's own HTML in a sandboxed frame: no scripts run. allow-same-origin only lets this page
 * reach into the frame to catch link clicks and open them in the system browser.
 */
function MailFrame({ html }: { html: string }): React.JSX.Element {
  const onLoad = (e: React.SyntheticEvent<HTMLIFrameElement>): void => {
    const doc = e.currentTarget.contentDocument
    doc?.addEventListener('click', (ev) => {
      const a = (ev.target as Element | null)?.closest?.('a[href]')
      if (!a) return
      ev.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (/^(https?|mailto):/i.test(href)) void window.api.app.openExternal(href)
    })
  }
  return <iframe className="gm-frame" sandbox="allow-same-origin" srcDoc={html} onLoad={onLoad} title="Nội dung thư" />
}

/* ================================ helpers ================================ */

/** `"Name" <a@b.c>` → { name: Name, addr: a@b.c }; a bare address is both. */
function splitAddress(from: string): { name: string; addr: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from)
  if (!m) return { name: from, addr: from }
  return { name: m[1].trim() || m[2], addr: m[2] }
}

function shortDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' })
}
