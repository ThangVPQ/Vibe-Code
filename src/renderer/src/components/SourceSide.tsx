import { memo, useEffect, useMemo } from 'react'
import { Monitor } from 'lucide-react'
import { create } from 'zustand'
import { useStore } from '../store'
import { ChangesView, ExplorerView, SectionFold, SectionHeader } from './Sidebar'
import { FolderIcon } from './icons'
import { THIS_PC, goPlace, loadPlaces, placeIcon, sizeText, useFx } from './places'

/**
 * Left column of the Source code tab, three sections that fold on their header:
 * This PC (places on the computer), the project's Files, its Git Changes.
 */
type Section = 'pc' | 'files' | 'changes'

const KEY = 'vibe.source.folded'
const useFolded = create<{ folded: Section[] }>(() => ({ folded: JSON.parse(localStorage.getItem(KEY) ?? '[]') as Section[] }))
function setFolded(folded: Section[]): void {
  useFolded.setState({ folded })
  localStorage.setItem(KEY, JSON.stringify(folded))
}

/** Ctrl+Shift+E / Ctrl+Shift+G: the project's files / changes, unfolded. */
export function showSection(s: Section): void {
  useStore.setState({ centerView: 'code' })
  setFolded(useFolded.getState().folded.filter((x) => x !== s))
}

function Fold({ id, children }: { id: Section; children: React.ReactNode }): React.JSX.Element {
  const open = useFolded((s) => !s.folded.includes(id))
  const fold = useMemo(
    () => ({
      open,
      toggle: () => {
        const { folded } = useFolded.getState()
        setFolded(open ? [...folded, id] : folded.filter((x) => x !== id))
      }
    }),
    [open, id]
  )
  return (
    <section className={`src-sec ${id}${open ? ' open' : ''}`}>
      <SectionFold.Provider value={fold}>{children}</SectionFold.Provider>
    </section>
  )
}

// memo (no props): EditorArea re-renders whenever any web page changes its address or title
export const SourceSide = memo(function SourceSide(): React.JSX.Element {
  const hasRoot = useStore((s) => !!s.root)
  return (
    <div className="sidebar code-tree">
      <Fold id="pc">
        <PlacesView />
      </Fold>
      {hasRoot && (
        <>
          <Fold id="files">
            <ExplorerView />
          </Fold>
          <Fold id="changes">
            <ChangesView />
          </Fold>
        </>
      )}
    </div>
  )
})

/** The computer's places: a click shows that folder in This PC. */
function PlacesView(): React.JSX.Element {
  const projectRoot = useStore((s) => s.root)
  const onPc = useStore((s) => s.centerView === 'files')
  const at = useFx((s) => s.path.toLowerCase())
  const places = useFx((s) => s.places)
  useEffect(loadPlaces, [])
  const on = (p: string): string => (onPc && at === p.toLowerCase() ? ' on' : '')
  const place = (p: (typeof places)[number]): React.JSX.Element => (
    <button
      key={p.path}
      className={`fx-place${on(p.path)}`}
      title={p.kind === 'drive' && p.total ? `${sizeText(p.free)} free of ${sizeText(p.total)}` : p.path}
      onClick={() => goPlace(p.path)}
    >
      {placeIcon(p.kind)}
      <span>{p.name}</span>
    </button>
  )
  return (
    <>
      <SectionHeader title="This PC" />
      <div className="fx-places">
        <button className={`fx-place${on(THIS_PC)}`} onClick={() => goPlace(THIS_PC)}>
          <Monitor size={15} className="fx-ic pc" />
          <span>This PC</span>
        </button>
        {projectRoot && (
          <button className={`fx-place${on(projectRoot)}`} title={projectRoot} onClick={() => goPlace(projectRoot)}>
            <FolderIcon open={false} size={15} />
            <span>{projectRoot.split(/[\\/]/).filter(Boolean).pop()}</span>
            <span className="fx-place-tag">project</span>
          </button>
        )}
        <div className="fx-nav-head">Quick access</div>
        {places.filter((p) => p.kind !== 'drive').map(place)}
        <div className="fx-nav-head">Drives</div>
        {places.filter((p) => p.kind === 'drive').map(place)}
      </div>
    </>
  )
}
