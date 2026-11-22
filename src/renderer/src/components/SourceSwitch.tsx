import { FileText, Monitor, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useStore } from '../store'
import { SlidePill } from './motion'
import { useT } from '../i18n'

/** Top of the Source code tab's left column: the project (Files above, Git Changes below) or This PC; folds the column. */
export function SourceSwitch(): React.JSX.Element {
  const t = useT()
  const side = useStore((s) => (s.centerView === 'files' ? 'pc' : 'files'))
  const changed = useStore((s) => s.git.files.length)
  const folded = useStore((s) => s.sourceFolded)
  const fold = (): void => {
    localStorage.setItem('vibe.sourceFolded', folded ? '0' : '1')
    useStore.setState({ sourceFolded: !folded })
  }
  return (
    <div className="code-side-switch">
      <SlidePill />
      <button className={side === 'files' ? 'on' : ''} title={t('Files and Git changes of this project', 'Tệp và thay đổi Git của dự án này')} onClick={() => useStore.setState({ centerView: 'code' })}>
        <FileText size={13} /> <span className="code-side-label">{t('Files', 'Tệp')}</span>
        {changed > 0 && <span className="center-count">{changed}</span>}
      </button>
      <button className={side === 'pc' ? 'on' : ''} title={t('Browse and read any file on this computer', 'Duyệt và đọc mọi tệp trên máy tính này')} onClick={() => useStore.setState({ centerView: 'files' })}>
        <Monitor size={13} /> <span className="code-side-label">This PC</span>
      </button>
      <button className="code-side-fold" title={folded ? t('Expand the column', 'Mở rộng cột') : t('Collapse the column', 'Thu gọn cột')} onClick={fold}>
        {folded ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
      </button>
    </div>
  )
}
