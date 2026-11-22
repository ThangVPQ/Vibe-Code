import { FileText, GitCompare, Monitor } from 'lucide-react'
import { useStore } from '../store'
import { SlidePill } from './motion'

/**
 * Top of the Source code tab's left column: the project's Files, its Git Changes, or This PC
 * (the whole-computer file browser). Shown in both the code view and the This PC view.
 */
export function SourceSwitch(): React.JSX.Element {
  const pc = useStore((s) => s.centerView === 'files')
  const side = useStore((s) => s.codeSide)
  const changed = useStore((s) => s.git.files.length)
  const show = (codeSide: 'files' | 'changes'): void => useStore.setState({ centerView: 'code', codeSide })
  return (
    <div className="code-side-switch">
      <SlidePill />
      <button className={!pc && side === 'files' ? 'on' : ''} title="Files of this project" onClick={() => show('files')}>
        <FileText size={13} /> Files
      </button>
      <button className={!pc && side === 'changes' ? 'on' : ''} title="Git changes of this project" onClick={() => show('changes')}>
        <GitCompare size={13} /> Changes
        {changed > 0 && <span className="center-count">{changed}</span>}
      </button>
      <button className={pc ? 'on' : ''} title="Browse and read any file on this computer" onClick={() => useStore.setState({ centerView: 'files' })}>
        <Monitor size={13} /> This PC
      </button>
    </div>
  )
}
