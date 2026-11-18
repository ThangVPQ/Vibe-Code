import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** iOS-style easing: quick start, long soft landing. */
export const IOS_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * A highlight that glides to the selected item of its parent (a tab strip, a segmented switch, a list).
 * Drop it in as a child; the parent gets `has-pill` and its selected item's own background is turned off in CSS.
 */
export function SlidePill({ selector = ':scope > .on, :scope > .active', className = '' }: { selector?: string; className?: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const pill = ref.current
    const host = pill?.parentElement
    if (!pill || !host) return
    host.classList.add('has-pill')
    let shown = false
    let frame = 0

    const place = (): void => {
      frame = 0
      const el = host.querySelector<HTMLElement>(selector)
      if (!el || !el.offsetParent || el.classList.contains('closing') || el.closest('.collapse:not(.open)')) {
        pill.style.opacity = '0'
        shown = false
        return
      }
      const hr = host.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      // Layout sizes and centres, so neither a panel easing in (scaled ancestor) nor a pressed item
      // (scaled around its centre) makes the highlight shrink or shift.
      const k = host.offsetWidth ? hr.width / host.offsetWidth : 1
      const w = el.offsetWidth
      const h = el.offsetHeight
      const x = (er.left + er.width / 2 - hr.left) / k - host.clientLeft + host.scrollLeft - w / 2
      const y = (er.top + er.height / 2 - hr.top) / k - host.clientTop + host.scrollTop - h / 2
      // first appearance: jump there, no slide from the corner
      if (!shown) pill.style.transition = 'none'
      pill.style.transform = `translate(${x}px, ${y}px)`
      pill.style.width = w + 'px'
      pill.style.height = h + 'px'
      pill.style.opacity = '1'
      if (!shown) {
        void pill.offsetWidth
        pill.style.transition = ''
        shown = true
      }
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(place)
    }

    const ro = new ResizeObserver(schedule)
    const watchKids = (): void => {
      ro.disconnect()
      ro.observe(host)
      for (const c of Array.from(host.children)) if (c !== pill) ro.observe(c)
    }
    watchKids()
    const mo = new MutationObserver((list) => {
      if (list.some((m) => m.type === 'childList' && m.target === host)) watchKids()
      schedule()
    })
    mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    // items that grow/shrink (CSS transition/animation) move their neighbours without resizing the host:
    // follow them frame by frame while that runs
    let until = 0
    let loop = 0
    const tick = (): void => {
      place()
      loop = performance.now() < until ? requestAnimationFrame(tick) : 0
    }
    const follow = (e: Event): void => {
      if (e.target === pill) return
      until = performance.now() + 500
      if (!loop) loop = requestAnimationFrame(tick)
    }
    host.addEventListener('transitionrun', follow)
    host.addEventListener('animationstart', follow)
    place()
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(loop)
      ro.disconnect()
      mo.disconnect()
      host.removeEventListener('transitionrun', follow)
      host.removeEventListener('animationstart', follow)
      host.classList.remove('has-pill')
    }
  }, [selector])

  return <div ref={ref} className={`slide-pill ${className}`} aria-hidden />
}

/** Plays a soft fade-and-rise on `ref` whenever `key` changes (for content that swaps in place). */
export function useEnterAnimation(ref: React.RefObject<HTMLElement>, key: unknown): void {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (reducedMotion()) return
    ref.current?.animate(
      [
        { opacity: 0, transform: 'translateY(6px) scale(0.996)' },
        { opacity: 1, transform: 'none' }
      ],
      { duration: 360, easing: IOS_EASE }
    )
  }, [key])
}

/** Height-animated show/hide (keeps the children mounted until the closing animation is done). */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }): JSX.Element | null {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      // next frame, so the 0 → full height change is animated
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)))
      return () => cancelAnimationFrame(r)
    }
    setExpanded(false)
    return undefined
  }, [open])
  if (!mounted) return null
  return (
    <div
      className={`collapse${expanded ? ' open' : ''}`}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && !open) setMounted(false)
      }}
    >
      <div className="collapse-inner">{children}</div>
    </div>
  )
}
