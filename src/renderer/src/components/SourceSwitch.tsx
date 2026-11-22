import { FileText, GitCompare } from 'lucide-react'
import { useStore } from '../store'
import { SlidePill } from './motion'

/** Top of the Source code tab's left column: the project's Files or its Git Changes. */
export function SourceSwitch(): React.JSX.Element {
  const side = useStore((s) => s.codeSide)
  const changed = useStore((s) => s.git.files.length)
  const show = (codeSide: 'files' | 'changes'): void => useStore.setState({ codeSide })
  return (
    <div className="code-side-switch">
      <SlidePill />
      <button className={side === 'files' ? 'on' : ''} title="Files of this project" onClick={() => show('files')}>
        <FileText size={13} /> Files
      </button>
      <button className={side === 'changes' ? 'on' : ''} title="Git changes of this project" onClick={() => show('changes')}>
        <GitCompare size={13} /> Changes
        {changed > 0 && <span className="center-count">{changed}</span>}
      </button>
    </div>
  )
}
