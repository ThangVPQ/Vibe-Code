import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Image as ImageIcon, X } from 'lucide-react'
import { useT } from '../i18n'

/** Every picture in a chat's conversation (pasted images, screenshots), oldest first; follows the transcript live. */
export function useChatImages(sessionId: string | undefined): string[] {
  const [images, setImages] = useState<string[]>([])

  useEffect(() => {
    setImages([])
    if (!sessionId) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // the backend sends the pictures again only when one was added (they are big data: URLs)
    let version: number | undefined
    const load = (): void => {
      window.api.sessions
        .images(sessionId, version)
        .then((r) => {
          if (!alive || !r.images) return
          version = r.version
          setImages(r.images)
        })
        .catch(() => {})
    }
    load()
    // this chat's transcript changed (pings for other chats are ignored)
    const off = window.api.sessions.onChanged((ids) => {
      if (!ids.includes(sessionId) && !ids.includes('*')) return
      clearTimeout(timer)
      timer = setTimeout(load, 700)
    })
    return () => {
      alive = false
      clearTimeout(timer)
      off()
    }
  }, [sessionId])

  return images
}

/** The Images tab of a chat: a grid, newest first. Click one to see it full size (← → to step, Esc to close). */
export function ChatImages({ images }: { images: string[] }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState<number | null>(null)
  const grid = useRef<HTMLDivElement>(null)

  // a new picture: back to the top, where the newest is
  useEffect(() => {
    grid.current?.scrollTo({ top: 0 })
  }, [images.length])

  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
      else if (e.key === 'ArrowLeft') setOpen((i) => (i === null ? i : Math.max(0, i - 1)))
      else if (e.key === 'ArrowRight') setOpen((i) => (i === null ? i : Math.min(images.length - 1, i + 1)))
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, images.length])

  return (
    <div className="chat-images">
      {images.length === 0 && (
        <div className="chat-images-empty">
          <ImageIcon size={22} />
          <p>{t('No images in this chat yet. Paste one (Ctrl+V) or let Claude take a screenshot.', 'Chat này chưa có ảnh nào. Dán ảnh vào (Ctrl+V) hoặc để Claude chụp màn hình.')}</p>
        </div>
      )}
      <div className="chat-images-grid" ref={grid}>
        {images
          .map((src, i) => ({ src, i }))
          .reverse()
          .map(({ src, i }) => (
            <button key={i} className="chat-image" title={t('Show full size', 'Xem kích thước đầy đủ')} onClick={() => setOpen(i)}>
              <img src={src} alt={t(`Image ${i + 1}`, `Ảnh ${i + 1}`)} draggable={false} />
              <span className="chat-image-num">#{i + 1}</span>
            </button>
          ))}
      </div>
      {open !== null && images[open] && (
        <div className="image-lightbox" onClick={() => setOpen(null)}>
          <img src={images[open]} alt={t(`Image ${open + 1}`, `Ảnh ${open + 1}`)} onClick={(e) => e.stopPropagation()} />
          <button className="lb-btn lb-close" title={t('Close (Esc)', 'Đóng (Esc)')} onClick={() => setOpen(null)}>
            <X size={18} />
          </button>
          {open > 0 && (
            <button
              className="lb-btn lb-prev"
              title={t('Previous (←)', 'Trước (←)')}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(open - 1)
              }}
            >
              <ChevronLeft size={22} />
            </button>
          )}
          {open < images.length - 1 && (
            <button
              className="lb-btn lb-next"
              title={t('Next (→)', 'Tiếp (→)')}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(open + 1)
              }}
            >
              <ChevronRight size={22} />
            </button>
          )}
          <span className="lb-count">
            {open + 1} / {images.length}
          </span>
        </div>
      )}
    </div>
  )
}
