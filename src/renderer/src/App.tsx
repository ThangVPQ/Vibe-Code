import { useEffect } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { useStore } from './store'
import { applyTheme, closeTab, defaultAgent, detectClaude, loadSessions, newChat, openFolder, refreshGit, selectChat, showChatBrowser, toggleBottom } from './actions'
import { focusTerm } from './terminals'
import { reloadIfClean } from './fileModelsLite'
import { QuickOpen, StatusBar, TitleBar, Welcome } from './components/Chrome'
import { Sidebar } from './components/Sidebar'
import { EditorArea } from './components/Editor'
import { BottomPanel, ClaudePanel } from './components/Claude'

function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      const s = useStore.getState()
      let handled = true
      if (ctrl && !e.shiftKey && k === 'p') useStore.setState({ quickOpen: !!s.root })
      else if (ctrl && e.shiftKey && k === 'o') window.dispatchEvent(new Event('go-to-symbol'))
      else if (ctrl && (e.key === '`' || e.code === 'Backquote')) toggleBottom()
      else if (ctrl && !e.shiftKey && k === 'b') useStore.setState({ sidebarOpen: !s.sidebarOpen })
      else if (ctrl && e.shiftKey && k === 'n') defaultAgent() && newChat()
      else if (ctrl && e.shiftKey && k === 'e') useStore.setState({ centerView: 'code' })
      else if (ctrl && e.shiftKey && k === 'g') useStore.setState({ centerView: 'code' })
      else if (ctrl && e.shiftKey && k === 'c') useStore.setState({ sidebarView: 'chats', sidebarOpen: true })
      else if (ctrl && !e.shiftKey && k === 'w' && s.activeTabId) closeTab(s.activeTabId)
      else if (e.altKey && !ctrl && /^[1-9]$/.test(e.key)) {
        const c = s.chats[parseInt(e.key) - 1]
        if (c) selectChat(c.id)
      } else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // capture phase: runs before xterm / monaco swallow the keystroke
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // "new Zalo task" notification clicked → show the Zalo tab
  useEffect(() => window.api.zalo.onShowTasks(() => useStore.setState({ centerView: 'zalo' })), [])
}

function useBoot(): void {
  useEffect(() => {
    ;(async () => {
      const [settings] = await Promise.all([window.api.app.settings(), detectClaude()])
      useStore.setState({ recent: settings.recentFolders, settings })
      applyTheme()
      if (settings.lastFolder) openFolder(settings.lastFolder).catch(() => {})
    })()

    window.api.win.state().then((win) => useStore.setState({ win }))
    loadSessions()

    const offs = [
      window.api.fs.onChanged((paths) => {
        refreshGit()
        // structural changes → refresh explorer
        useStore.setState((s) => ({ fsTick: s.fsTick + 1 }))
        for (const p of paths) reloadIfClean(p)
        window.dispatchEvent(new CustomEvent('fs-changed', { detail: paths }))
      }),
      window.api.sessions.onChanged(loadSessions),
      window.api.browser.onOpen(showChatBrowser),
      window.api.win.onState((win) => useStore.setState({ win })),
      // drop-down just slid in → put the cursor straight into the active chat
      window.api.win.onShown(() => {
        const id = useStore.getState().activeChatId
        if (id) focusTerm(id)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])
}

function Handle({ dir }: { dir: 'h' | 'v' }): React.JSX.Element {
  return <Separator className={`resize-handle ${dir}`} />
}

export default function App(): React.JSX.Element {
  useBoot()
  useGlobalKeys()
  const root = useStore((s) => s.root)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const bottomOpen = useStore((s) => s.bottomOpen)
  const quickOpen = useStore((s) => s.quickOpen)
  const dropdown = useStore((s) => s.win?.mode === 'dropdown')
  // layouts are remembered per set of visible panels (sidebar / bottom panel can be toggled)
  const layoutH = useDefaultLayout({ id: 'layout-h', panelIds: sidebarOpen ? ['sidebar', 'center', 'claude'] : ['center', 'claude'], storage: localStorage })
  const layoutV = useDefaultLayout({ id: 'layout-v', panelIds: bottomOpen ? ['editor', 'bottom'] : ['editor'], storage: localStorage })

  return (
    <div className={`app${dropdown ? ' mode-dropdown' : ''}`}>
      <TitleBar />
      {!root ? (
        <Welcome />
      ) : (
        <div className="workbench">
          <Group orientation="horizontal" className="panels" defaultLayout={layoutH.defaultLayout} onLayoutChanged={layoutH.onLayoutChanged}>
            {sidebarOpen && (
              <>
                <Panel id="sidebar" defaultSize="19%" minSize="13%" maxSize="35%">
                  <Sidebar />
                </Panel>
                <Handle dir="h" />
              </>
            )}
            <Panel id="center" defaultSize="45%" minSize="20%">
              <Group orientation="vertical" defaultLayout={layoutV.defaultLayout} onLayoutChanged={layoutV.onLayoutChanged}>
                <Panel id="editor" defaultSize="68%" minSize="20%">
                  <EditorArea />
                </Panel>
                {bottomOpen && (
                  <>
                    <Handle dir="v" />
                    <Panel id="bottom" defaultSize="32%" minSize="12%">
                      <BottomPanel />
                    </Panel>
                  </>
                )}
              </Group>
            </Panel>
            <Handle dir="h" />
            <Panel id="claude" defaultSize="36%" minSize="22%">
              <ClaudePanel />
            </Panel>
          </Group>
        </div>
      )}
      <StatusBar />
      {quickOpen && root && <QuickOpen />}
    </div>
  )
}
