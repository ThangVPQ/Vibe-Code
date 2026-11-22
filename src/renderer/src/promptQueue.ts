import { create } from 'zustand'
import { useStore, type ChatStatus } from './store'
import { holdAttachments, putBackAttachments, releaseAttachments, type Attachment } from './attachments'
import { menuShown, sendPrompt } from './terminals'

/**
 * Messages written in the Chat tab while Claude is still working. They wait above the message box
 * (with their files) and go out one by one as turns end — or right away with "Send now"; X takes
 * one back into the message box.
 */
export interface QueuedPrompt {
  id: string
  text: string
  files: Attachment[]
}

export const usePromptQueue = create<{ byChat: Record<string, QueuedPrompt[]> }>(() => ({ byChat: {} }))

let seq = 0
const queueOf = (chatId: string): QueuedPrompt[] => usePromptQueue.getState().byChat[chatId] ?? []

function setQueue(chatId: string, next: QueuedPrompt[]): void {
  usePromptQueue.setState((s) => {
    const byChat = { ...s.byChat }
    if (next.length) byChat[chatId] = next
    else delete byChat[chatId]
    return { byChat }
  })
}

function take(chatId: string, id: string): QueuedPrompt | undefined {
  const q = queueOf(chatId)
  const item = q.find((x) => x.id === id)
  if (item) setQueue(chatId, q.filter((x) => x !== item))
  return item
}

/** Park a message (and the files in the tray) until Claude is done. */
export function queuePrompt(chatId: string, text: string): void {
  const files = holdAttachments(chatId)
  setQueue(chatId, [...queueOf(chatId), { id: `q${++seq}`, text, files }])
}

/** Send a parked message now: Claude Code takes it in while it works. */
export function sendQueuedNow(chatId: string, id: string): void {
  const item = take(chatId, id)
  if (!item) return
  sendPrompt(chatId, item.text, item.files)
  releaseAttachments(item.files)
}

/** Take a parked message back (its files return to the tray); the text is the caller's to put back. */
export function unqueue(chatId: string, id: string): QueuedPrompt | undefined {
  const item = take(chatId, id)
  if (item) putBackAttachments(chatId, item.files)
  return item
}

/* a turn ended: the next parked message goes out (watched here, so it also happens on the Terminal tab) */
let last = new Map<string, ChatStatus>()
useStore.subscribe((s) => {
  const now = new Map(s.chats.map((c) => [c.id, c.status]))
  for (const [id, status] of now) {
    const was = last.get(id)
    if (status === 'idle' && was && was !== 'idle' && queueOf(id).length) {
      // a short wait: the status can blink idle between two steps of the same turn
      setTimeout(() => {
        const chat = useStore.getState().chats.find((c) => c.id === id)
        const first = queueOf(id)[0]
        if (chat?.status === 'idle' && first && !menuShown(id)) sendQueuedNow(id, first.id)
      }, 600)
    }
  }
  // closed chats: drop what they had parked
  for (const id of Object.keys(usePromptQueue.getState().byChat)) if (!now.has(id)) setQueue(id, [])
  last = now
})
