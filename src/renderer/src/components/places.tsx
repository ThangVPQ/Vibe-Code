import { create } from 'zustand'
import { Download, FileText, HardDrive, Home, Image as ImageIcon, Monitor, Music, Video } from 'lucide-react'
import type { ExPlace } from '../../../shared/types'
import { useStore } from '../store'
// the This PC section of the left column uses its styles before the (lazy) pane loads
import './explorer.css'

/* Source code › This PC, the parts the left column shares with the (lazily loaded) pane */

/** '' is "This PC": the folders and drives page */
export const THIS_PC = ''

/** The folder This PC shows, the computer's places, and the pane's navigation once it is mounted. */
export const useFx = create<{ path: string; places: ExPlace[]; go: ((p: string) => void) | null }>(() => ({
  path: localStorage.getItem('vibe.fx.path') ?? THIS_PC,
  places: [],
  go: null
}))

export const loadPlaces = (): void => void window.api.fs.places().then((places) => useFx.setState({ places }), () => {})

/** Show `p` in This PC (before the pane's first visit: it starts there). */
export function goPlace(p: string): void {
  const { go } = useFx.getState()
  if (go) go(p)
  else useFx.setState({ path: p })
  useStore.setState({ centerView: 'files' })
}

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} ${units[u]}`
}

export function placeIcon(kind: ExPlace['kind'], size = 15): React.ReactNode {
  switch (kind) {
    case 'home':
      return <Home size={size} className="fx-ic home" />
    case 'desktop':
      return <Monitor size={size} className="fx-ic desktop" />
    case 'documents':
      return <FileText size={size} className="fx-ic docs" />
    case 'downloads':
      return <Download size={size} className="fx-ic downloads" />
    case 'pictures':
      return <ImageIcon size={size} className="fx-ic pictures" />
    case 'videos':
      return <Video size={size} className="fx-ic videos" />
    case 'music':
      return <Music size={size} className="fx-ic music" />
    default:
      return <HardDrive size={size} className="fx-ic drive" />
  }
}
