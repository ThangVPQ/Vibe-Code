import { useEffect, useState } from 'react'
import { Check, Loader2, LogOut, QrCode, RefreshCw, TriangleAlert, Wifi, WifiOff } from 'lucide-react'
import type { ZaloState } from '../../../shared/types'
import { ZaloTasks } from './zalo/ZaloTasks'
import { Avatar } from './zalo/Avatar'
import { useT } from '../i18n'
import './zalo/zalo.css'

/** Zalo tab: QR login, then just the connection status and Claude's task list (no messenger, no Windows notifications). */
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
  if (state.status === 'off' || state.status === 'qr' || (!state.self && state.status !== 'connecting')) return <ZaloLogin state={state} />
  return <ZaloConnected state={state} />
}

/* ================================ login ================================ */

function ZaloLogin({ state }: { state: ZaloState }): React.JSX.Element {
  const t = useT()
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
              <img src={state.qr} alt={t('Zalo login QR code', 'Mã QR đăng nhập Zalo')} />
              {state.scanned && (
                <div className="zl-qr-done">
                  <Check size={34} />
                </div>
              )}
            </div>
            <h2>{state.scanned ? t(`Hello, ${state.scanned}`, `Xin chào, ${state.scanned}`) : t('Sign in to Zalo with a QR code', 'Đăng nhập Zalo bằng mã QR')}</h2>
            {state.scanned ? (
              <p className="zl-login-sub">{t('Tap “Log in” on your phone to finish.', 'Bấm “Đăng nhập” trên điện thoại để hoàn tất.')}</p>
            ) : (
              <ol className="zl-steps">
                <li>{t('Open Zalo on your phone', 'Mở Zalo trên điện thoại')}</li>
                <li>
                  {t('Tap the', 'Bấm biểu tượng')} <QrCode size={13} /> {t('icon next to the search box', 'cạnh ô tìm kiếm')}
                </li>
                <li>{t('Point the camera at this code to scan it', 'Hướng camera vào mã này để quét')}</li>
              </ol>
            )}
            <button className="zl-link-btn" onClick={() => void window.api.zalo.cancel()}>
              {t('Cancel', 'Huỷ')}
            </button>
          </>
        ) : (
          <>
            <div className="zl-logo">
              <span>Zalo</span>
            </div>
            <h2>{t('Zalo in VIBE CODE', 'Zalo trong VIBE CODE')}</h2>
            <p className="zl-login-sub">
              {t(
                'Connect your personal Zalo account so Claude can read your messages through the zalo_* tools and sum up your to-dos.',
                'Kết nối tài khoản Zalo cá nhân để Claude đọc tin nhắn qua tool zalo_* và tóm tắt việc cần làm.'
              )}
            </p>
            {(waitingQr || state.status === 'connecting') && (
              <p className="zl-login-sub">
                <Loader2 size={14} className="zl-spin" />{' '}
                {state.status === 'connecting' ? t('Reconnecting the saved session…', 'Đang kết nối lại phiên đã lưu…') : t('Getting the QR code…', 'Đang lấy mã QR…')}
              </p>
            )}
            {state.error && <p className="zl-login-error">{state.error}</p>}
            {!waitingQr && state.status !== 'connecting' && (
              <div className="zl-login-actions">
                <button className="zl-primary" disabled={busy} onClick={start}>
                  <QrCode size={16} /> {t('Sign in with QR', 'Đăng nhập bằng QR')}
                </button>
                {state.status === 'error' && (
                  <button className="zl-secondary" onClick={() => void window.api.zalo.reconnect()}>
                    <RefreshCw size={14} /> {t('Reconnect', 'Kết nối lại')}
                  </button>
                )}
              </div>
            )}
          </>
        )}
        <p className="zl-login-warn">
          <TriangleAlert size={13} />{' '}
          {t(
            'Uses an unofficial API (zca-js), the same way Zalo Web works; Zalo may lock your account for this. Each account keeps only one web session: opening chat.zalo.me elsewhere disconnects the session here.',
            'Dùng API không chính thức (zca-js), giống cách Zalo Web hoạt động; Zalo có thể khoá tài khoản vì việc này. Mỗi tài khoản chỉ giữ một phiên web: mở chat.zalo.me ở nơi khác thì phiên ở đây bị ngắt.'
          )}
        </p>
      </div>
    </div>
  )
}

/* ================================ connected ================================ */

/** Logged in: no messenger here (chats stay on the phone) — just the connection, plus Claude's "Việc của tôi" list. */
function ZaloConnected({ state }: { state: ZaloState }): React.JSX.Element {
  const t = useT()
  const [syncing, setSyncing] = useState(false)
  const offline = state.status !== 'online'
  const me = state.self
  return (
    <div className="zl-home">
      <div className="zl-conn-card">
        <Avatar id={me?.id ?? 'me'} name={me?.name ?? 'Zalo'} src={me?.avatar} size={46} />
        <div className="zl-conn-info">
          <div className="zl-conn-name">{me?.name || 'Zalo'}</div>
          <div className={'zl-conn-status ' + (state.status === 'online' ? 'ok' : state.status === 'connecting' ? 'wait' : 'err')}>
            {state.status === 'connecting' ? <Loader2 size={12} className="zl-spin" /> : state.status === 'online' ? <Wifi size={12} /> : <WifiOff size={12} />}
            {state.status === 'online'
              ? t('Connected — Claude can read messages through the zalo_* tools', 'Đã kết nối — Claude đọc được tin nhắn qua tool zalo_*')
              : state.status === 'connecting'
                ? t('Connecting…', 'Đang kết nối…')
                : state.error || t('Disconnected', 'Mất kết nối')}
          </div>
        </div>
        <button
          className="zl-icon"
          title={t('Sync all conversations', 'Đồng bộ tất cả cuộc trò chuyện')}
          disabled={offline || syncing}
          onClick={() => {
            setSyncing(true)
            void window.api.zalo.syncAll().finally(() => setSyncing(false))
          }}
        >
          <RefreshCw size={17} className={syncing ? 'zl-spin' : undefined} />
        </button>
        {state.status === 'error' && (
          <button className="zl-icon" title={t('Sign in again with QR', 'Đăng nhập lại bằng QR')} onClick={() => void window.api.zalo.login()}>
            <QrCode size={17} />
          </button>
        )}
        <button
          className="zl-icon danger"
          title={t('Sign out', 'Đăng xuất')}
          onClick={() => {
            void window.api
              .ask(t('Sign out of Zalo and delete all messages synced on this computer?', 'Đăng xuất Zalo và xoá toàn bộ tin nhắn đã đồng bộ trên máy này?'))
              .then((ok) => (ok ? window.api.zalo.logout() : undefined))
          }}
        >
          <LogOut size={17} />
        </button>
      </div>
      <ZaloTasks />
    </div>
  )
}
