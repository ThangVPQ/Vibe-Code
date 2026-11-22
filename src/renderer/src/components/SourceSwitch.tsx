import { FileText, GitCompare, Monitor, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useStore } from '../store'
import { SlidePill } from './motion'

/** Top of the Source code tab's left column: the project's Files, its Git Changes, or This PC; folds the column. */
export function SourceSwitch(): React.JSX.Element {
  const side = useStore((s) => (s.centerView === 'files' ? 'pc' : s.codeSide))
  const changed = useStore((s) => s.git.files.length)
  const folded = useStore((s) => s.sourceFolded)
  const show = (codeSide: 'files' | 'changes'): void => useStore.setState({ centerView: 'code', codeSide })
  const fold = (): void => {
    localStorage.setItem('vibe.sourceFolded', folded ? '0' : '1')
    useStore.setState({ sourceFolded: !folded })
  }
  return (
    <div className="code-side-switch">
      <SlidePill />
      <button className={side === 'files' ? 'on' : ''} title="Files of this project" onClick={() => show('files')}>
        <FileText size={13} /> <span className="code-side-label">Files</span>
      </button>
      <button className={side === 'changes' ? 'on' : ''} title="Git changes of this project" onClick={() => show('changes')}>
        <GitCompare size={13} /> <span className="code-side-label">Changes</span>
        {changed > 0 && <span className="center-count">{changed}</span>}
      </button>
      <button className={side === 'pc' ? 'on' : ''} title="Browse and read any file on this computer" onClick={() => useStore.setState({ centerView: 'files' })}>
        <Monitor size={13} /> <span className="code-side-label">This PC</span>
      </button>
      <button className="code-side-fold" title={folded ? 'Expand the column' : 'Collapse the column'} onClick={fold}>
        {folded ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
      </button>
    </div>
  )
}
