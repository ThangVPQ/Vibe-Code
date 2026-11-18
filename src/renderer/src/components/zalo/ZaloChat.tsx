import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  CornerUpLeft,
  CornerUpRight,
  Download,
  ExternalLink,
  FileText,
  Info,
  Link2,
  Loader2,
  MapPin,
  Paperclip,
  Pause,
  Play,
  Search,
  SendHorizontal,
  Smile,
  Trash2,
  Undo2,
  Users,
  X
} from 'lucide-react'
import { Check, CheckCheck } from 'lucide-react'
import type { ZaloMessage, ZaloSticker, ZaloThread, ZaloThreadInfo, ZaloTyping } from '../../../../shared/types'
import { openBrowser } from '../../actions'
import { Avatar, TypingDots } from './Avatar'
import {
  dayLabel,
  EMOJI_GROUPS,
  errText,
  fileColor,
  fmtDuration,
  fmtSize,
  hhmm,
  isEmojiOnly,
  lastSeen,
  peerColor,
  QUICK_REACTIONS,
  reactionEmoji,
  sameRun,
  URL_RE
} from './util'

const PAGE = 150
const HAS_URL = new RegExp(URL_RE.source)

type Pending = { key: string; text: string; ts: number; status: 'sending' | 'failed'; replyTo?: ZaloMessage; realId?: string }
type Media = { kind: 'photo' | 'video'; src: string; thumb?: string; caption?: string }

interface Props {
  thread: ZaloThread
  self?: { id: string; name: string; avatar: string }
  online: boolean
  changed: { ids: string[]; n: number }
  typing?: ZaloTyping
  draft: string
  setDraft: (v: string) => void
  threads: ZaloThread[]
  onClose: () => void
}

export function ZaloChat({ thread, self, online, changed, typing, draft, setDraft, threads, onClose }: Props): React.JSX.Element {
  const id = thread.id
  const [msgs, setMsgs] = useState<ZaloMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [cloudDone, setCloudDone] = useState(!thread.group)
  const [loadingOld, setLoadingOld] = useState(false)
  const [pending, setPending] = useState<Pending[]>([])
  const [info, setInfo] = useState<ZaloThreadInfo | null>(null)
  const [reply, setReply] = useState<ZaloMessage | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [search, setSearch] = useState<{ q: string; idx: number } | null>(null)
  const [ctx, setCtx] = useState<{ m: ZaloMessage; x: number; y: number } | null>(null)
  const [media, setMedia] = useState<Media | null>(null)
  const [forwarding, setForwarding] = useState<ZaloMessage | null>(null)
  const [attach, setAttach] = useState<string[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newBelow, setNewBelow] = useState(0)
  // where the unread messages start (captured when the chat opens)
  const [unreadFrom] = useState(thread.unread ?? 0)
  const [unreadAnchor, setUnreadAnchor] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prevFirst = useRef<{ id?: string; height: number }>({ height: 0 })
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const flash = (text: string): void => {
    setToast(text)
    setTimeout(() => setToast((t) => (t === text ? null : t)), 2600)
  }

  // messages: first page, then whenever this conversation changes
  const msgsRef = useRef<ZaloMessage[]>([])
  const reload = (n = limit): Promise<void> =>
    window.api.zalo.messages(id, n).then((list) => {
      const old = msgsRef.current
      if (old.length && !stick.current) {
        const known = new Set(old.map((m) => m.id))
        const added = list.filter((m) => !known.has(m.id) && !m.self && m.ts >= (old.at(-1)?.ts ?? 0)).length
        if (added) setNewBelow((c) => c + added)
      }
      msgsRef.current = list
      setMsgs(list)
      setLoaded(true)
    })
  useEffect(() => {
    void reload(PAGE)
    void window.api.zalo.info(id).then(setInfo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  useEffect(() => {
    if (changed.n && (changed.ids.length === 0 || changed.ids.includes(id))) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed.n])

  // a pending message is done once the real one shows up
  useEffect(() => {
    if (!pending.some((p) => p.realId)) return
    const ids = new Set(msgs.map((m) => m.id))
    setPending((ps) => ps.filter((p) => !p.realId || !ids.has(p.realId)))
  }, [msgs, pending])

  // the unread separator sits before the first of the unread incoming messages
  useEffect(() => {
    if (!loaded || unreadAnchor !== null || !unreadFrom) return
    const incoming = msgs.filter((m) => !m.self)
    const first = incoming[Math.max(0, incoming.length - unreadFrom)]
    setUnreadAnchor(first?.id ?? '')
  }, [loaded, msgs, unreadFrom, unreadAnchor])

  // scrolling: stay at the bottom, keep the position when older messages are prepended
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const first = msgs[0]?.id
    if (prevFirst.current.id && first !== prevFirst.current.id && !stick.current) {
      el.scrollTop += el.scrollHeight - prevFirst.current.height
    } else if (stick.current) {
      if (unreadAnchor && !prevFirst.current.id) {
        el.querySelector(`[data-sep="unread"]`)?.scrollIntoView({ block: 'center' })
      } else el.scrollTop = el.scrollHeight
    }
    prevFirst.current = { id: first, height: el.scrollHeight }
  }, [msgs, pending, unreadAnchor])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stick.current = bottom
    setAtBottom(bottom)
    if (bottom) setNewBelow(0)
    prevFirst.current.height = el.scrollHeight
    if (el.scrollTop < 120 && loaded && !loadingOld) void loadMore()
  }

  const loadMore = async (): Promise<void> => {
    if (msgs.length >= limit) {
      const n = limit + PAGE
      setLimit(n)
      await reload(n)
      return
    }
    if (cloudDone || !online) return
    setLoadingOld(true)
    try {
      const got = await window.api.zalo.loadOlder(id)
      if (!got) setCloudDone(true)
      else {
        const n = limit + got
        setLimit(n)
        await reload(n)
      }
    } catch {
      setCloudDone(true)
    } finally {
      setLoadingOld(false)
    }
  }

  const toBottom = (): void => {
    const el = listRef.current
    if (!el) return
    stick.current = true
    setNewBelow(0)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const jumpTo = (msgId: string): void => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(msgId)}"]`)
    if (!el) {
      flash('Tin nhắn gốc chưa được đồng bộ về máy này')
      return
    }
    stick.current = false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('zl-flash')
    void el.offsetWidth
    el.classList.add('zl-flash')
  }

  /* ---------------- sending ---------------- */

  const sendText = async (text: string, replyTo?: ZaloMessage, key = `p${Date.now()}`): Promise<void> => {
    stick.current = true
    setPending((ps) => [...ps.filter((p) => p.key !== key), { key, text, ts: Date.now(), status: 'sending', replyTo }])
    try {
      const realId = await window.api.zalo.send(id, text, replyTo?.id)
      setPending((ps) => (realId ? ps.map((p) => (p.key === key ? { ...p, realId } : p)) : ps.filter((p) => p.key !== key)))
    } catch (e) {
      setPending((ps) => ps.map((p) => (p.key === key ? { ...p, status: 'failed' } : p)))
      flash(errText(e))
    }
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const r = reply
    setReply(null)
    void sendText(text, r ?? undefined)
  }

  const sendSticker = async (s: ZaloSticker): Promise<void> => {
    stick.current = true
    try {
      await window.api.zalo.sendSticker(id, s)
    } catch (e) {
      flash(errText(e))
    }
  }

  const addFiles = (paths: string[]): void => {
    const ok = paths.filter(Boolean)
    if (ok.length) setAttach((a) => [...(a ?? []), ...ok])
  }

  const onPaste = async (e: React.ClipboardEvent): Promise<void> => {
    const files = [...e.clipboardData.files]
    if (!files.length) return
    e.preventDefault()
    const paths: string[] = []
    for (const f of files) {
      const p = window.api.app.pathFor(f)
      if (p) paths.push(p)
      else if (f.type.startsWith('image/')) paths.push(await window.api.app.saveImage(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1] || 'png'))
    }
    addFiles(paths)
  }

  /* ---------------- message actions ---------------- */

  const act = async (fn: () => Promise<void>, done?: string): Promise<void> => {
    try {
      await fn()
      if (done) flash(done)
    } catch (e) {
      flash(errText(e))
    }
  }
  const react = (m: ZaloMessage, icon: string): void => {
    const mine = self && m.reactions?.[icon]?.includes(self.id)
    void act(() => window.api.zalo.react(id, m.id, mine ? '' : icon))
  }

  const startReply = (m: ZaloMessage): void => {
    setReply(m)
    inputRef.current?.focus()
  }

  // keys: Esc closes the innermost thing, Ctrl+F searches
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (ctx) setCtx(null)
      else if (media) setMedia(null)
      else if (forwarding) setForwarding(null)
      else if (attach) setAttach(null)
      else if (search) setSearch(null)
      else if (reply) setReply(null)
      else if (showInfo) setShowInfo(false)
      else onClose()
      e.stopPropagation()
    }
    if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setSearch((s) => s ?? { q: '', idx: 0 })
    }
  }

  /* ---------------- search in chat ---------------- */

  const matches = useMemo(() => {
    const q = search?.q.trim().toLowerCase()
    if (!q) return []
    return msgs.filter((m) => !m.recalled && (m.text.toLowerCase().includes(q) || (m.att?.title ?? '').toLowerCase().includes(q))).map((m) => m.id)
  }, [msgs, search?.q])
  const current = search && matches.length ? matches[matches.length - 1 - Math.min(search.idx, matches.length - 1)] : null
  useEffect(() => {
    if (current) jumpTo(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  /* ---------------- render ---------------- */

  const subtitle = typing ? (
    <span className="zl-head-typing">
      {thread.group && typing.name ? `${typing.name} đang soạn tin` : 'đang soạn tin'}
      <TypingDots />
    </span>
  ) : thread.group ? (
    `${info?.members ?? thread.members ?? '?'} thành viên`
  ) : (
    lastSeen(info?.lastOnline, info?.online) || 'Zalo'
  )

  const items: React.ReactNode[] = []
  let lastDay = ''
  msgs.forEach((m, i) => {
    const day = new Date(m.ts).toDateString()
    if (day !== lastDay) {
      lastDay = day
      items.push(
        <div key={'d' + m.id} className="zl-sep">
          <span>{dayLabel(m.ts)}</span>
        </div>
      )
    }
    if (unreadAnchor && m.id === unreadAnchor)
      items.push(
        <div key="unread" className="zl-sep zl-sep-unread" data-sep="unread">
          <span>Tin nhắn chưa đọc</span>
        </div>
      )
    const prev = msgs[i - 1]
    const next = msgs[i + 1]
    const first = !sameRun(prev, m)
    const last = !sameRun(m, next)
    items.push(
      <Bubble
        key={m.id}
        m={m}
        first={first}
        last={last}
        group={thread.group}
        selfId={self?.id}
        query={search?.q.trim() || ''}
        current={current === m.id}
        onContext={(e) => {
          e.preventDefault()
          setCtx({ m, x: e.clientX, y: e.clientY })
        }}
        onReply={() => startReply(m)}
        onReact={(icon) => react(m, icon)}
        onJump={jumpTo}
        onMedia={setMedia}
      />
    )
  })
  pending.forEach((p, i) => {
    const prevSelf = i > 0 || msgs.at(-1)?.self
    items.push(
      <div key={p.key} className={'zl-msg self' + (prevSelf ? '' : ' first') + (i === pending.length - 1 ? ' last' : '')}>
        <div className="zl-bubble">
          {p.replyTo && (
            <div className="zl-reply" style={{ ['--peer' as string]: peerColor(p.replyTo.fromId) }}>
              <b>{p.replyTo.self ? 'Bạn' : p.replyTo.fromName}</b>
              <span>{p.replyTo.att ? p.replyTo.att.title || '[đính kèm]' : p.replyTo.text}</span>
            </div>
          )}
          <span className="zl-text">{p.text}</span>
          <span className="zl-meta">
            {hhmm(p.ts)}
            {p.status === 'sending' ? (
              <Clock3 size={12} />
            ) : (
              <button className="zl-retry" title="Gửi lại" onClick={() => void sendText(p.text, p.replyTo, p.key)}>
                <AlertCircle size={14} />
              </button>
            )}
          </span>
        </div>
      </div>
    )
  })

  return (
    <div
      className={'zl-chat' + (showInfo ? ' with-info' : '')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) setDragging(true)
      }}
    >
      <div className="zl-chat-col">
        <header className="zl-head">
          {search ? (
            <div className="zl-head-search">
              <Search size={16} />
              <input
                autoFocus
                placeholder="Tìm trong cuộc trò chuyện"
                value={search.q}
                onChange={(e) => setSearch({ q: e.target.value, idx: 0 })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setSearch((s) => s && { ...s, idx: e.shiftKey ? Math.max(0, s.idx - 1) : Math.min(matches.length - 1, s.idx + 1) })
                }}
              />
              <span className="zl-dim">{search.q ? (matches.length ? `${Math.min(search.idx, matches.length - 1) + 1}/${matches.length}` : 'Không có kết quả') : ''}</span>
              <button className="zl-icon" disabled={!matches.length} onClick={() => setSearch((s) => s && { ...s, idx: Math.min(matches.length - 1, s.idx + 1) })}>
                <ChevronUp size={18} />
              </button>
              <button className="zl-icon" disabled={!matches.length} onClick={() => setSearch((s) => s && { ...s, idx: Math.max(0, s.idx - 1) })}>
                <ChevronDown size={18} />
              </button>
              <button className="zl-icon" onClick={() => setSearch(null)}>
                <X size={18} />
              </button>
            </div>
          ) : (
            <>
              <button className="zl-head-peer" onClick={() => setShowInfo((v) => !v)}>
                <Avatar id={id} name={thread.name || id} src={info?.avatar ?? thread.avatar} size={42} group={thread.group} />
                <span className="zl-head-text">
                  <span className="zl-head-name">{thread.name || id}</span>
                  <span className={'zl-head-sub' + (info?.online ? ' online' : '')}>{subtitle}</span>
                </span>
              </button>
              <button className="zl-icon" title="Tìm kiếm (Ctrl+F)" onClick={() => setSearch({ q: '', idx: 0 })}>
                <Search size={19} />
              </button>
              <button className={'zl-icon' + (showInfo ? ' on' : '')} title="Thông tin" onClick={() => setShowInfo((v) => !v)}>
                <Info size={19} />
              </button>
            </>
          )}
        </header>

        <div className="zl-wall">
          <div className="zl-msgs" ref={listRef} onScroll={onScroll}>
            <div className="zl-msgs-inner">
              {loadingOld && (
                <div className="zl-older">
                  <Loader2 size={16} className="zl-spin" />
                </div>
              )}
              {loaded && !msgs.length && !pending.length && (
                <div className="zl-empty-chat">
                  <div className="zl-empty-card">
                    <div className="zl-empty-emoji">👋</div>
                    <b>Chưa có tin nhắn</b>
                    <span>
                      Zalo chỉ đồng bộ tin nhắn mới từ lúc đăng nhập (và một ít lịch sử gần đây). Gửi lời chào{thread.group ? '' : ` tới ${thread.name}`} nhé!
                    </span>
                    <button onClick={() => void sendText('👋')}>Gửi 👋</button>
                  </div>
                </div>
              )}
              {items}
            </div>
          </div>
          {(!atBottom || newBelow > 0) && (
            <button className="zl-fab" onClick={toBottom} title="Xuống tin mới nhất">
              <ArrowDown size={20} />
              {newBelow > 0 && <span className="zl-badge">{newBelow}</span>}
            </button>
          )}
          {toast && <div className="zl-toast">{toast}</div>}
        </div>

        <Composer
          thread={thread}
          inputRef={inputRef}
          draft={draft}
          setDraft={setDraft}
          reply={reply}
          clearReply={() => setReply(null)}
          onSubmit={submit}
          onPaste={(e) => void onPaste(e)}
          onAttach={() => void window.api.app.pickFiles().then(addFiles)}
          onSticker={(s) => void sendSticker(s)}
          online={online}
        />
      </div>

      {showInfo && <InfoPanel thread={thread} info={info} msgs={msgs} onClose={() => setShowInfo(false)} onMedia={setMedia} onJump={jumpTo} />}

      {dragging && (
        <div
          className="zl-drop"
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            addFiles([...e.dataTransfer.files].map((f) => window.api.app.pathFor(f)))
          }}
        >
          <div className="zl-drop-box">
            <Paperclip size={30} />
            <b>Thả file vào đây để gửi</b>
            <span>Ảnh được gửi dạng ảnh, file khác gửi dạng tệp</span>
          </div>
        </div>
      )}

      {ctx && (
        <ContextMenu
          {...ctx}
          selfId={self?.id}
          onClose={() => setCtx(null)}
          onReact={(icon) => react(ctx.m, icon)}
          onReply={() => startReply(ctx.m)}
          onCopy={() => {
            void navigator.clipboard.writeText(ctx.m.att?.url && ctx.m.att.kind !== 'link' ? ctx.m.att.url : ctx.m.text)
            flash('Đã sao chép')
          }}
          onForward={() => setForwarding(ctx.m)}
          onRecall={() => void act(() => window.api.zalo.recall(id, ctx.m.id), 'Đã thu hồi tin nhắn')}
          onDelete={() => void act(() => window.api.zalo.deleteForMe(id, ctx.m.id), 'Đã xoá ở phía bạn')}
        />
      )}
      {media && <Lightbox media={media} onClose={() => setMedia(null)} />}
      {forwarding && (
        <ForwardDialog
          threads={threads}
          onClose={() => setForwarding(null)}
          onPick={(to) => {
            const m = forwarding
            setForwarding(null)
            void act(() => window.api.zalo.forward(id, m.id, to.id), `Đã chuyển tiếp tới ${to.name}`)
          }}
        />
      )}
      {attach && (
        <AttachDialog
          paths={attach}
          onRemove={(p) => setAttach((a) => (a && a.length > 1 ? a.filter((x) => x !== p) : null))}
          onClose={() => setAttach(null)}
          onMore={() => void window.api.app.pickFiles().then(addFiles)}
          onSend={(caption) => {
            const paths = attach
            setAttach(null)
            stick.current = true
            void act(() => window.api.zalo.sendFiles(id, paths, caption))
          }}
        />
      )}
    </div>
  )
}

/* ================================ bubble ================================ */

function Bubble({
  m,
  first,
  last,
  group,
  selfId,
  query,
  current,
  onContext,
  onReply,
  onReact,
  onJump,
  onMedia
}: {
  m: ZaloMessage
  first: boolean
  last: boolean
  group: boolean
  selfId?: string
  query: string
  current: boolean
  onContext: (e: React.MouseEvent) => void
  onReply: () => void
  onReact: (icon: string) => void
  onJump: (id: string) => void
  onMedia: (m: Media) => void
}): React.JSX.Element {
  const a = m.att
  const showName = group && !m.self && first
  const bare = !m.recalled && ((a && (a.kind === 'sticker' || a.kind === 'gif')) || (!a && isEmojiOnly(m.text)))
  const mediaOnly = !m.recalled && a && (a.kind === 'photo' || a.kind === 'video') && !a.title && !m.reply
  const cls = ['zl-msg', m.self ? 'self' : 'in', first && 'first', last && 'last', bare && 'bare', mediaOnly && 'media-only', current && 'zl-current'].filter(Boolean).join(' ')
  const meta = (
    <span className="zl-meta">
      {hhmm(m.ts)}
      {m.self && (m.status === 'seen' ? <CheckCheck size={14} className="seen" /> : <Check size={14} />)}
    </span>
  )
  return (
    <div className={cls} data-id={m.id} onContextMenu={onContext} onDoubleClick={onReply}>
      {group && !m.self && <span className="zl-msg-av">{last && <Avatar id={m.fromId} name={m.fromName} size={34} />}</span>}
      <div className="zl-bubble" title={new Date(m.ts).toLocaleString('vi-VN')}>
        {showName && !bare && (
          <div className="zl-from" style={{ color: peerColor(m.fromId) }}>
            {m.fromName}
          </div>
        )}
        {m.reply && !m.recalled && (
          <button className="zl-reply" style={{ ['--peer' as string]: peerColor(m.reply.from) }} onClick={() => onJump(m.reply!.id)}>
            <b>{m.reply.from}</b>
            <span>{m.reply.text || 'Tin nhắn'}</span>
          </button>
        )}
        {m.recalled ? (
          <span className="zl-text zl-recalled">
            <Undo2 size={13} /> Tin nhắn đã được thu hồi
          </span>
        ) : a ? (
          <AttachmentView m={m} onMedia={onMedia} query={query} />
        ) : (
          <span className={'zl-text' + (bare ? ' zl-big-emoji' : '')}>
            <RichText text={m.text} mentions={m.mentions} query={query} />
          </span>
        )}
        {m.reactions && <Reactions reactions={m.reactions} selfId={selfId} onReact={onReact} />}
        {meta}
      </div>
    </div>
  )
}

function Reactions({ reactions, selfId, onReact }: { reactions: Record<string, string[]>; selfId?: string; onReact: (icon: string) => void }): React.JSX.Element {
  return (
    <span className="zl-reacts">
      {Object.entries(reactions)
        .sort((x, y) => y[1].length - x[1].length)
        .map(([icon, uids]) => (
          <button
            key={icon}
            className={'zl-react' + (selfId && uids.includes(selfId) ? ' mine' : '')}
            onClick={(e) => {
              e.stopPropagation()
              onReact(icon)
            }}
          >
            <span>{reactionEmoji(icon)}</span>
            {uids.length > 1 && <b>{uids.length}</b>}
          </button>
        ))}
    </span>
  )
}

/** Text with @mentions, clickable links and search hits. */
function RichText({ text, mentions, query }: { text: string; mentions?: ZaloMessage['mentions']; query: string }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  const ranges = (mentions ?? []).filter((x) => x.len > 0 && x.pos >= 0 && x.pos + x.len <= text.length).sort((x, y) => x.pos - y.pos)
  let at = 0
  const plain = (s: string, key: string): void => {
    let i = 0
    for (const u of s.matchAll(URL_RE)) {
      if (u.index! > i) parts.push(<Hl key={key + 't' + i} s={s.slice(i, u.index)} q={query} />)
      const url = u[0]
      parts.push(
        <a
          key={key + 'u' + u.index}
          href={url}
          onClick={(e) => {
            e.preventDefault()
            openBrowser(url)
          }}
        >
          <Hl s={url} q={query} />
        </a>
      )
      i = u.index! + url.length
    }
    if (i < s.length) parts.push(<Hl key={key + 't' + i} s={s.slice(i)} q={query} />)
  }
  for (const r of ranges) {
    if (r.pos < at) continue
    plain(text.slice(at, r.pos), 'p' + at)
    parts.push(
      <span key={'m' + r.pos} className="zl-mention">
        <Hl s={text.slice(r.pos, r.pos + r.len)} q={query} />
      </span>
    )
    at = r.pos + r.len
  }
  plain(text.slice(at), 'p' + at)
  return <>{parts}</>
}

function Hl({ s, q }: { s: string; q: string }): React.JSX.Element {
  if (!q) return <>{s}</>
  const low = s.toLowerCase()
  const ql = q.toLowerCase()
  const out: React.ReactNode[] = []
  let i = 0
  for (let j = low.indexOf(ql); j >= 0; j = low.indexOf(ql, i)) {
    if (j > i) out.push(s.slice(i, j))
    out.push(<mark key={j}>{s.slice(j, j + q.length)}</mark>)
    i = j + q.length
  }
  out.push(s.slice(i))
  return <>{out}</>
}

/** Fit a picture into the bubble keeping its shape. */
function fit(w?: number, h?: number, maxW = 340, maxH = 380): { width: number; height: number } {
  if (!w || !h) return { width: 280, height: 210 }
  const k = Math.min(maxW / w, maxH / h, 1)
  return { width: Math.max(140, Math.round(w * k)), height: Math.max(90, Math.round(h * k)) }
}

function AttachmentView({ m, onMedia, query }: { m: ZaloMessage; onMedia: (x: Media) => void; query: string }): React.JSX.Element {
  const a = m.att!
  const caption = a.title && (a.kind === 'photo' || a.kind === 'video') ? (
    <span className="zl-text zl-caption">
      <RichText text={a.title} query={query} />
    </span>
  ) : null
  switch (a.kind) {
    case 'photo': {
      const size = fit(a.width, a.height)
      return (
        <>
          <button className="zl-photo" style={size} onClick={() => a.url && onMedia({ kind: 'photo', src: a.url, thumb: a.thumb, caption: a.title })}>
            <img src={a.thumb || a.url} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} />
          </button>
          {caption}
        </>
      )
    }
    case 'video': {
      const size = fit(a.width, a.height)
      return (
        <>
          <button className="zl-photo zl-video" style={size} onClick={() => a.url && onMedia({ kind: 'video', src: a.url, thumb: a.thumb, caption: a.title })}>
            {a.thumb ? <img src={a.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} /> : <span className="zl-video-blank" />}
            <span className="zl-play">
              <Play size={22} fill="currentColor" />
            </span>
            {a.duration ? <span className="zl-vdur">{fmtDuration(a.duration)}</span> : null}
          </button>
          {caption}
        </>
      )
    }
    case 'sticker':
    case 'gif':
      return a.url ? (
        <img className="zl-sticker" src={a.url} alt={a.kind} loading="lazy" referrerPolicy="no-referrer" draggable={false} style={a.kind === 'gif' ? fit(a.width, a.height, 240, 240) : undefined} />
      ) : (
        <span className="zl-sticker zl-sticker-ph">{a.kind === 'gif' ? 'GIF' : 'Sticker'}</span>
      )
    case 'voice':
      return <Voice url={a.url} duration={a.duration} seed={m.id} />
    case 'file':
      return (
        <button className="zl-file" onClick={() => a.url && void window.api.app.openExternal(a.url)} title="Tải về">
          <span className="zl-file-ic" style={{ background: fileColor(a.ext) }}>
            <span>{(a.ext || 'file').slice(0, 4).toUpperCase()}</span>
            <Download size={16} className="zl-file-dl" />
          </span>
          <span className="zl-file-body">
            <span className="zl-file-name">
              <Hl s={a.title || 'Tệp'} q={query} />
            </span>
            <span className="zl-file-size">{fmtSize(a.size) || 'Bấm để tải về'}</span>
          </span>
        </button>
      )
    case 'link':
      return (
        <>
          {a.url && (
            <span className="zl-text">
              <RichText text={a.url} query={query} />
            </span>
          )}
          <button className="zl-preview" onClick={() => a.url && openBrowser(a.url)}>
            <span className="zl-preview-body">
              <b>{hostOf(a.url)}</b>
              {a.title && <span className="zl-preview-title">{a.title}</span>}
              {a.desc && <span className="zl-preview-desc">{a.desc}</span>}
            </span>
            {a.thumb && <img src={a.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />}
          </button>
        </>
      )
    case 'location':
      return (
        <button className="zl-file" onClick={() => a.url && openBrowser(a.url)}>
          <span className="zl-file-ic" style={{ background: '#e5534b' }}>
            <MapPin size={20} />
          </span>
          <span className="zl-file-body">
            <span className="zl-file-name">{a.title || 'Vị trí'}</span>
            <span className="zl-file-size">{a.desc || 'Mở bản đồ'}</span>
          </span>
        </button>
      )
    case 'card':
      return (
        <span className="zl-card">
          <Avatar id={a.title ?? 'card'} name={a.title ?? '?'} src={a.thumb} size={44} />
          <span className="zl-file-body">
            <span className="zl-file-name">{a.title || 'Danh thiếp'}</span>
            <span className="zl-file-size">{a.desc || 'Danh thiếp Zalo'}</span>
          </span>
        </span>
      )
    default:
      return (
        <span className="zl-text">
          {a.title || a.desc ? <RichText text={[a.title, a.desc].filter(Boolean).join('\n')} query={query} /> : <span className="zl-dim">[{m.type}]</span>}
          {a.url && (
            <>
              {' '}
              <a
                href={a.url}
                onClick={(e) => {
                  e.preventDefault()
                  openBrowser(a.url!)
                }}
              >
                Mở
              </a>
            </>
          )}
        </span>
      )
  }
}

const hostOf = (url?: string): string => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : 'Link'
  } catch {
    return 'Link'
  }
}

/** Voice message: play button, a waveform made from the message id, elapsed / total time. */
function Voice({ url, duration, seed }: { url?: string; duration?: number; seed: string }): React.JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [total, setTotal] = useState(duration ?? 0)
  const bars = useMemo(() => {
    let h = 7
    return Array.from({ length: 36 }, (_, i) => {
      h = (h * 31 + seed.charCodeAt(i % seed.length)) % 997
      return 0.25 + ((h % 100) / 100) * 0.75
    })
  }, [seed])
  const pct = total ? t / total : 0
  const toggle = (): void => {
    const el = ref.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }
  return (
    <span className="zl-voice">
      <audio
        ref={ref}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setT(0)
        }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setTotal(e.currentTarget.duration)}
      />
      <button className="zl-voice-btn" onClick={toggle} disabled={!url}>
        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <span className="zl-voice-body">
        <span
          className="zl-wave"
          onClick={(e) => {
            const el = ref.current
            if (!el || !total) return
            const r = e.currentTarget.getBoundingClientRect()
            el.currentTime = ((e.clientX - r.left) / r.width) * total
          }}
        >
          {bars.map((h, i) => (
            <i key={i} className={i / bars.length < pct ? 'on' : ''} style={{ height: `${h * 100}%` }} />
          ))}
        </span>
        <span className="zl-voice-time">{fmtDuration(playing || t ? t : total)}</span>
      </span>
    </span>
  )
}

/* ================================ composer ================================ */

function Composer({
  thread,
  inputRef,
  draft,
  setDraft,
  reply,
  clearReply,
  onSubmit,
  onPaste,
  onAttach,
  onSticker,
  online
}: {
  thread: ZaloThread
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  draft: string
  setDraft: (v: string) => void
  reply: ZaloMessage | null
  clearReply: () => void
  onSubmit: () => void
  onPaste: (e: React.ClipboardEvent) => void
  onAttach: () => void
  onSticker: (s: ZaloSticker) => void
  online: boolean
}): React.JSX.Element {
  const [picker, setPicker] = useState(false)

  // grow with the text, up to a limit
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [draft, inputRef])

  useEffect(() => {
    inputRef.current?.focus()
  }, [inputRef])

  const insert = (s: string): void => {
    const el = inputRef.current
    if (!el) return setDraft(draft + s)
    const a = el.selectionStart ?? draft.length
    const b = el.selectionEnd ?? draft.length
    setDraft(draft.slice(0, a) + s + draft.slice(b))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(a + s.length, a + s.length)
    })
  }

  return (
    <div className="zl-compose-wrap">
      {picker && (
        <>
          <div className="zl-scrim" onClick={() => setPicker(false)} />
          <EmojiPanel
            onEmoji={insert}
            onSticker={(s) => {
              setPicker(false)
              onSticker(s)
            }}
          />
        </>
      )}
      <div className="zl-compose">
        {reply && (
          <div className="zl-compose-reply">
            <CornerUpLeft size={20} className="zl-accent" />
            <div className="zl-reply" style={{ ['--peer' as string]: peerColor(reply.fromId) }}>
              <b>Trả lời {reply.self ? 'chính bạn' : reply.fromName}</b>
              <span>{reply.att ? reply.att.title || '[đính kèm]' : reply.text}</span>
            </div>
            <button className="zl-icon" onClick={clearReply}>
              <X size={18} />
            </button>
          </div>
        )}
        <div className="zl-compose-row">
          <button className="zl-icon" title="Đính kèm ảnh / file" onClick={onAttach}>
            <Paperclip size={21} />
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={online ? `Nhắn tới ${thread.name || 'cuộc trò chuyện'}` : 'Đang mất kết nối…'}
            value={draft}
            onPaste={onPaste}
            onChange={(e) => {
              setDraft(e.target.value)
              if (e.target.value) window.api.zalo.typing(thread.id)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onSubmit()
              }
            }}
          />
          <button className={'zl-icon' + (picker ? ' on' : '')} title="Emoji & sticker" onClick={() => setPicker((v) => !v)}>
            <Smile size={21} />
          </button>
          <button className={'zl-send' + (draft.trim() ? ' ready' : '')} title="Gửi (Enter)" disabled={!draft.trim()} onClick={onSubmit}>
            <SendHorizontal size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}

const STICKER_KEYS = ['hi', 'yêu', 'haha', 'ok', 'cảm ơn', 'buồn', 'giận', 'chúc mừng']

function EmojiPanel({ onEmoji, onSticker }: { onEmoji: (e: string) => void; onSticker: (s: ZaloSticker) => void }): React.JSX.Element {
  const [tab, setTab] = useState<'emoji' | 'sticker'>('sticker')
  const [group, setGroup] = useState(0)
  const [kw, setKw] = useState('hi')
  const [stickers, setStickers] = useState<ZaloSticker[] | null>(null)
  const [err, setErr] = useState('')
  const emojis = useMemo(() => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(EMOJI_GROUPS[group].list)].map((s) => s.segment), [group])

  useEffect(() => {
    if (tab !== 'sticker') return
    let live = true
    setStickers(null)
    setErr('')
    const t = setTimeout(
      () =>
        void window.api.zalo
          .stickers(kw)
          .then((l) => live && setStickers(l))
          .catch((e) => live && (setErr(errText(e)), setStickers([]))),
      250
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [tab, kw])

  return (
    <div className="zl-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="zl-panel-tabs">
        <button className={tab === 'sticker' ? 'on' : ''} onClick={() => setTab('sticker')}>
          Sticker
        </button>
        <button className={tab === 'emoji' ? 'on' : ''} onClick={() => setTab('emoji')}>
          Emoji
        </button>
      </div>
      {tab === 'emoji' ? (
        <>
          <div className="zl-emoji-grid">
            {emojis.map((e, i) => (
              <button key={i} onClick={() => onEmoji(e)}>
                {e}
              </button>
            ))}
          </div>
          <div className="zl-emoji-groups">
            {EMOJI_GROUPS.map((g, i) => (
              <button key={g.name} title={g.name} className={i === group ? 'on' : ''} onClick={() => setGroup(i)}>
                {g.icon}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="zl-sticker-search">
            <Search size={14} />
            <input autoFocus value={kw} placeholder="Tìm sticker" onChange={(e) => setKw(e.target.value)} />
          </div>
          <div className="zl-sticker-keys">
            {STICKER_KEYS.map((k) => (
              <button key={k} className={k === kw ? 'on' : ''} onClick={() => setKw(k)}>
                {k}
              </button>
            ))}
          </div>
          <div className="zl-sticker-grid">
            {stickers === null && <Loader2 size={20} className="zl-spin zl-center" />}
            {stickers?.length === 0 && <span className="zl-dim zl-center">{err || 'Không có sticker'}</span>}
            {stickers?.map((s) => (
              <button key={s.id} onClick={() => onSticker(s)}>
                <img src={s.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* ================================ overlays ================================ */

function ContextMenu({
  m,
  x,
  y,
  selfId,
  onClose,
  onReact,
  onReply,
  onCopy,
  onForward,
  onRecall,
  onDelete
}: {
  m: ZaloMessage
  x: number
  y: number
  selfId?: string
  onClose: () => void
  onReact: (icon: string) => void
  onReply: () => void
  onCopy: () => void
  onForward: () => void
  onRecall: () => void
  onDelete: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
  }, [x, y])
  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const recent = Date.now() - m.ts < 24 * 3600_000
  return (
    <>
      <div
        className="zl-scrim"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="zl-ctx" ref={ref} style={pos}>
        {!m.recalled && (
          <div className="zl-ctx-reacts">
            {QUICK_REACTIONS.map((r) => (
              <button key={r} className={selfId && m.reactions?.[r]?.includes(selfId) ? 'mine' : ''} onClick={run(() => onReact(r))}>
                {reactionEmoji(r)}
              </button>
            ))}
          </div>
        )}
        <div className="zl-ctx-list">
          {!m.recalled && (
            <button onClick={run(onReply)}>
              <CornerUpLeft size={16} /> Trả lời
            </button>
          )}
          {!m.recalled && (
            <button onClick={run(onCopy)}>
              <Copy size={16} /> {m.att && m.att.kind !== 'link' ? 'Sao chép link' : 'Sao chép'}
            </button>
          )}
          {!m.recalled && (
            <button onClick={run(onForward)}>
              <CornerUpRight size={16} /> Chuyển tiếp
            </button>
          )}
          {m.self && !m.recalled && recent && (
            <button onClick={run(onRecall)}>
              <Undo2 size={16} /> Thu hồi
            </button>
          )}
          <button className="danger" onClick={run(onDelete)}>
            <Trash2 size={16} /> Xoá ở phía tôi
          </button>
        </div>
        <div className="zl-ctx-time">{new Date(m.ts).toLocaleString('vi-VN')}</div>
      </div>
    </>
  )
}

function Lightbox({ media, onClose }: { media: Media; onClose: () => void }): React.JSX.Element {
  const [zoom, setZoom] = useState(false)
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="zl-lightbox" onClick={onClose}>
      <div className="zl-lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="zl-lb-cap">{media.caption}</span>
        <button className="zl-icon" title="Mở trong trình duyệt / tải về" onClick={() => void window.api.app.openExternal(media.src)}>
          <ExternalLink size={19} />
        </button>
        <button className="zl-icon" title="Đóng (Esc)" onClick={onClose}>
          <X size={21} />
        </button>
      </div>
      {media.kind === 'photo' ? (
        <img
          className={'zl-lb-media' + (zoom ? ' zoom' : '')}
          src={media.src}
          alt=""
          referrerPolicy="no-referrer"
          onClick={(e) => {
            e.stopPropagation()
            setZoom((z) => !z)
          }}
        />
      ) : (
        <video className="zl-lb-media" src={media.src} poster={media.thumb} controls autoPlay onClick={(e) => e.stopPropagation()} />
      )}
    </div>
  )
}

function ForwardDialog({ threads, onPick, onClose }: { threads: ZaloThread[]; onPick: (t: ZaloThread) => void; onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const list = threads.filter((t) => t.name && (!q || t.name.toLowerCase().includes(q.toLowerCase()))).slice(0, 80)
  return (
    <div className="zl-modal-bg" onMouseDown={onClose}>
      <div className="zl-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zl-modal-head">
          <b>Chuyển tiếp tới…</b>
          <button className="zl-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label className="zl-search zl-modal-search">
          <Search size={15} />
          <input autoFocus placeholder="Tìm cuộc trò chuyện" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && list[0] && onPick(list[0])} />
        </label>
        <div className="zl-modal-list">
          {list.map((t) => (
            <button key={t.id} className="zl-pick" onClick={() => onPick(t)}>
              <Avatar id={t.id} name={t.name} src={t.avatar} size={38} group={t.group} />
              <span>{t.name}</span>
              {t.group && <Users size={13} className="zl-dim" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function AttachDialog({
  paths,
  onRemove,
  onClose,
  onMore,
  onSend
}: {
  paths: string[]
  onRemove: (p: string) => void
  onClose: () => void
  onMore: () => void
  onSend: (caption: string) => void
}): React.JSX.Element {
  const [infos, setInfos] = useState<Record<string, { size: number; preview?: string }>>({})
  const [caption, setCaption] = useState('')
  useEffect(() => {
    const missing = paths.filter((p) => !infos[p])
    if (!missing.length) return
    void window.api.app.fileInfo(missing).then((l) => setInfos((m) => ({ ...m, ...Object.fromEntries(l.map((x) => [x.path, x])) })))
  }, [paths, infos])
  const name = (p: string): string => p.split(/[\\/]/).pop() ?? p
  const images = paths.filter((p) => infos[p]?.preview)
  return (
    <div className="zl-modal-bg" onMouseDown={onClose}>
      <div className="zl-modal zl-attach" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zl-modal-head">
          <b>
            Gửi {paths.length} {images.length === paths.length ? 'ảnh' : 'tệp'}
          </b>
          <button className="zl-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="zl-attach-list">
          {paths.map((p) => {
            const i = infos[p]
            const ext = name(p).split('.').pop()?.toLowerCase()
            return (
              <div key={p} className={'zl-attach-item' + (i?.preview ? ' img' : '')}>
                {i?.preview ? (
                  <img src={i.preview} alt="" />
                ) : (
                  <span className="zl-file-ic" style={{ background: fileColor(ext) }}>
                    <FileText size={18} />
                  </span>
                )}
                {!i?.preview && (
                  <span className="zl-file-body">
                    <span className="zl-file-name">{name(p)}</span>
                    <span className="zl-file-size">{fmtSize(i?.size)}</span>
                  </span>
                )}
                <button className="zl-attach-x" onClick={() => onRemove(p)}>
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
        <textarea
          className="zl-attach-cap"
          autoFocus
          rows={1}
          placeholder="Thêm chú thích…"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSend(caption.trim())
            }
          }}
        />
        <div className="zl-modal-foot">
          <button className="zl-link-btn" onClick={onMore}>
            <Paperclip size={14} /> Thêm
          </button>
          <span style={{ flex: 1 }} />
          <button className="zl-link-btn" onClick={onClose}>
            Huỷ
          </button>
          <button className="zl-primary sm" onClick={() => onSend(caption.trim())}>
            Gửi
          </button>
        </div>
      </div>
    </div>
  )
}

/* ================================ info panel ================================ */

function InfoPanel({
  thread,
  info,
  msgs,
  onClose,
  onMedia,
  onJump
}: {
  thread: ZaloThread
  info: ZaloThreadInfo | null
  msgs: ZaloMessage[]
  onClose: () => void
  onMedia: (m: Media) => void
  onJump: (id: string) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'media' | 'file' | 'link'>('media')
  const media = msgs.filter((m) => !m.recalled && (m.att?.kind === 'photo' || m.att?.kind === 'video')).reverse()
  const files = msgs.filter((m) => !m.recalled && m.att?.kind === 'file').reverse()
  const links = msgs
    .filter((m) => !m.recalled && (m.att?.kind === 'link' || (!m.att && HAS_URL.test(m.text))))
    .map((m) => ({ m, url: m.att?.url ?? m.text.match(URL_RE)?.[0] ?? '' }))
    .reverse()
  const name = info?.name || thread.name || thread.id
  const copy = (v: string): void => void navigator.clipboard.writeText(v)
  return (
    <aside className="zl-info">
      <div className="zl-info-head">
        <b>{thread.group ? 'Thông tin nhóm' : 'Thông tin'}</b>
        <button className="zl-icon" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="zl-info-scroll">
        <div className="zl-info-hero">
          <Avatar id={thread.id} name={name} src={info?.avatar ?? thread.avatar} size={96} group={thread.group} />
          <b>{name}</b>
          <span className={info?.online ? 'online' : ''}>
            {thread.group ? `${info?.members ?? thread.members ?? '?'} thành viên` : lastSeen(info?.lastOnline, info?.online) || 'Zalo'}
          </span>
        </div>
        <div className="zl-info-rows">
          {info?.desc && (
            <div className="zl-info-row">
              <Info size={18} />
              <span>
                <span className="zl-info-v">{info.desc}</span>
                <span className="zl-info-k">{thread.group ? 'Mô tả' : 'Trạng thái'}</span>
              </span>
            </div>
          )}
          {info?.phone && (
            <button className="zl-info-row" onClick={() => copy(info.phone!)}>
              <span className="zl-info-ic">☎</span>
              <span>
                <span className="zl-info-v">{info.phone}</span>
                <span className="zl-info-k">Điện thoại</span>
              </span>
            </button>
          )}
          <button className="zl-info-row" onClick={() => copy(thread.id)} title="Sao chép">
            <span className="zl-info-ic">#</span>
            <span>
              <span className="zl-info-v">{thread.id}</span>
              <span className="zl-info-k">{thread.group ? 'ID nhóm' : 'ID người dùng'} · bấm để sao chép</span>
            </span>
          </button>
        </div>
        <div className="zl-info-tabs">
          <button className={tab === 'media' ? 'on' : ''} onClick={() => setTab('media')}>
            Ảnh/Video {media.length ? media.length : ''}
          </button>
          <button className={tab === 'file' ? 'on' : ''} onClick={() => setTab('file')}>
            File {files.length ? files.length : ''}
          </button>
          <button className={tab === 'link' ? 'on' : ''} onClick={() => setTab('link')}>
            Link {links.length ? links.length : ''}
          </button>
        </div>
        {tab === 'media' &&
          (media.length ? (
            <div className="zl-info-grid">
              {media.map((m) => (
                <button key={m.id} onClick={() => m.att?.url && onMedia({ kind: m.att.kind === 'video' ? 'video' : 'photo', src: m.att.url, thumb: m.att.thumb, caption: m.att.title })}>
                  <img src={m.att?.thumb || m.att?.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  {m.att?.kind === 'video' && <Play size={18} fill="currentColor" className="zl-info-play" />}
                </button>
              ))}
            </div>
          ) : (
            <p className="zl-info-empty">Chưa có ảnh hoặc video</p>
          ))}
        {tab === 'file' &&
          (files.length ? (
            files.map((m) => (
              <button key={m.id} className="zl-info-item" onClick={() => m.att?.url && void window.api.app.openExternal(m.att.url)}>
                <span className="zl-file-ic sm" style={{ background: fileColor(m.att?.ext) }}>
                  <span>{(m.att?.ext || 'file').slice(0, 4).toUpperCase()}</span>
                </span>
                <span className="zl-file-body">
                  <span className="zl-file-name">{m.att?.title}</span>
                  <span className="zl-file-size">
                    {fmtSize(m.att?.size)} · {new Date(m.ts).toLocaleDateString('vi-VN')}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <p className="zl-info-empty">Chưa có file</p>
          ))}
        {tab === 'link' &&
          (links.length ? (
            links.map(({ m, url }) => (
              <Fragment key={m.id}>
                <button className="zl-info-item" onClick={() => onJump(m.id)} onDoubleClick={() => openBrowser(url)}>
                  <span className="zl-file-ic sm" style={{ background: 'var(--zl-accent)' }}>
                    <Link2 size={16} />
                  </span>
                  <span className="zl-file-body">
                    <span className="zl-file-name">{m.att?.title || hostOf(url)}</span>
                    <span className="zl-file-size zl-accent">{url}</span>
                  </span>
                </button>
              </Fragment>
            ))
          ) : (
            <p className="zl-info-empty">Chưa có link</p>
          ))}
      </div>
    </aside>
  )
}
