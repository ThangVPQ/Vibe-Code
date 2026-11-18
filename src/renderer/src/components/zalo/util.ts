import type { ZaloMessage } from '../../../../shared/types'

export const errText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

/* ---------------- colors: Telegram's seven peer colors ---------------- */

const PEER = ['#e17076', '#f0a35e', '#a695e7', '#7bc862', '#5fbfc2', '#65aadd', '#ee7aae']
const PEER_DARK = ['#c94f5a', '#e0833a', '#8774d9', '#56ad42', '#3ea4a8', '#4590c9', '#d95c97']

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
export const peerColor = (id: string): string => PEER[hash(id) % PEER.length]
export const peerGradient = (id: string): string => {
  const i = hash(id) % PEER.length
  return `linear-gradient(180deg, ${PEER[i]} 0%, ${PEER_DARK[i]} 100%)`
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/* ---------------- time ---------------- */

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

/** list time: 14:05 today, weekday this week, dd/mm this year, dd/mm/yy before */
export function listTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (sameDay(d, now)) return hhmm(ts)
  const days = (now.getTime() - d.getTime()) / 86_400_000
  if (days < 6) return d.toLocaleDateString('vi-VN', { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export const hhmm = (ts: number): string => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false })

export function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (sameDay(d, now)) return 'Hôm nay'
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (sameDay(d, y)) return 'Hôm qua'
  return d.toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

export function lastSeen(lastOnline?: number, online?: boolean): string {
  if (online) return 'vừa truy cập'
  if (!lastOnline) return ''
  const ms = lastOnline < 1e12 ? lastOnline * 1000 : lastOnline
  const min = Math.round((Date.now() - ms) / 60_000)
  if (min < 1) return 'vừa truy cập'
  if (min < 60) return `truy cập ${min} phút trước`
  const h = Math.round(min / 60)
  if (h < 24) return `truy cập ${h} giờ trước`
  return `truy cập ${new Date(ms).toLocaleDateString('vi-VN')}`
}

export const fmtDuration = (s?: number): string => {
  if (!s || !Number.isFinite(s)) return '0:00'
  const t = Math.round(s)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

export function fmtSize(b?: number): string {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

/* ---------------- reactions: Zalo codes ↔ emoji ---------------- */

export const REACTION_EMOJI: Record<string, string> = {
  '/-heart': '❤️',
  '/-strong': '👍',
  ':>': '😆',
  ':o': '😮',
  ':-((': '😭',
  ':-h': '😡',
  ':-*': '😘',
  ":')": '😂',
  '/-shit': '💩',
  '/-rose': '🌹',
  '/-break': '💔',
  '/-weak': '👎',
  ';xx': '😍',
  ';-/': '😕',
  ';-)': '😉',
  '/-fade': '🥀',
  '/-li': '☀️',
  '/-bd': '🎂',
  '/-bome': '💣',
  '/-ok': '👌',
  '/-v': '✌️',
  '/-thanks': '🙏',
  '/-punch': '👊',
  '/-share': '🔗',
  '_()_': '🙏',
  '/-no': '🙅',
  '/-bad': '😤',
  '/-loveu': '🥰',
  '--b': '😓',
  ':((': '😢',
  'x-)': '😎',
  '8-)': '🤓',
  ';-d': '😁',
  'b-)': '😎',
  ':--|': '😐',
  'p-(': '😞',
  ':-bye': '👋',
  '|-)': '😴',
  ':wipe': '😅',
  ':-dig': '🤔',
  '&-(': '😧',
  ':handclap': '👏',
  '>-|': '😠',
  ';-x': '🤐',
  ':-o': '😲',
  ';-s': '😳',
  ';-a': '😨',
  ':-<': '☹️',
  ':))': '🤣',
  '$-)': '🤑',
  '/-beer': '🍺'
}
/** the six Zalo shows first */
export const QUICK_REACTIONS = ['/-heart', '/-strong', ':>', ':o', ':-((', ':-h']
export const reactionEmoji = (code: string): string => REACTION_EMOJI[code] ?? code

/* ---------------- emoji picker ---------------- */

export const EMOJI_GROUPS: { name: string; icon: string; list: string }[] = [
  { name: 'Mặt cười', icon: '😀', list: '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁☹️😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀☠️💩🤡👻👽🤖' },
  { name: 'Cử chỉ', icon: '👍', list: '👋🤚🖐✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆🖕👇☝️👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍️💅🤳💪🦾🧠👀👁👅👄💋' },
  { name: 'Trái tim', icon: '❤️', list: '❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟☮️✝️☯️✨⭐🌟💫🔥💥💯✅❌❓❗💤🎉🎊🎁🎂🏆🥇' },
  { name: 'Đồ vật', icon: '☕', list: '☕🍵🍺🍻🥂🍷🍹🍕🍔🍟🌭🍿🥗🍜🍣🍱🍰🧁🍩🍪🍫🍬🍭🍎🍉🍓🍒🍑🥭🍍🥥💻⌨️🖥📱📞📷🎧🎮🚗✈️🏠⏰📅📌📎✏️📝📦💰💸💳' },
  { name: 'Thiên nhiên', icon: '🌸', list: '🌸🌹🌺🌻🌼🌷🌱🌲🌳🌴🌵🍀🍁🍂🍃☀️🌤⛅🌧⛈🌈❄️☃️🌊🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🦄🐝🦋🐢🐍🐙🐠🐬🐳' }
]

/** 1–3 emoji and nothing else: shown big, without a bubble */
export function isEmojiOnly(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 24) return false
  const seg = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)].map((s) => s.segment).filter((s) => s.trim())
  return seg.length <= 3 && seg.every((s) => /\p{Extended_Pictographic}/u.test(s))
}

/* ---------------- grouping ---------------- */

/** consecutive messages from one sender within 5 minutes form one stack */
export function sameRun(a: ZaloMessage | undefined, b: ZaloMessage | undefined): boolean {
  if (!a || !b) return false
  return a.fromId === b.fromId && Math.abs(b.ts - a.ts) < 5 * 60_000 && new Date(a.ts).toDateString() === new Date(b.ts).toDateString()
}

/** file badge color by extension */
export function fileColor(ext = ''): string {
  if (/^(pdf)$/.test(ext)) return '#e5534b'
  if (/^(docx?|rtf|odt)$/.test(ext)) return '#3b82f6'
  if (/^(xlsx?|csv|ods)$/.test(ext)) return '#22a55b'
  if (/^(pptx?|odp)$/.test(ext)) return '#ef7d33'
  if (/^(zip|rar|7z|tar|gz)$/.test(ext)) return '#a37cf0'
  if (/^(mp3|wav|m4a|aac|ogg)$/.test(ext)) return '#ec5f9b'
  if (/^(mp4|mov|avi|mkv)$/.test(ext)) return '#e0a03a'
  return '#5b8def'
}

export const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g
