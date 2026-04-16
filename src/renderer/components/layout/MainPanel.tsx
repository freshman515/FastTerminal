import { useEffect } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import { usePanesStore } from '@/stores/panes'
import { SplitContainer } from '@/components/split/SplitContainer'
import { AgentOrchestratorPanel } from '@/components/rightpanel/AgentOrchestratorPanel'

export function MainPanel(): JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions)
  const activeTabId = usePanesStore((s) => s.paneActiveSession[s.activePaneId] ?? null)
  const fullscreenPaneId = usePanesStore((s) => s.fullscreenPaneId)

  const activeSession = sessions.find((s) => s.id === activeTabId)
  useEffect(() => {
    document.title = activeSession ? `${activeSession.name} — FastTerminal` : 'FastTerminal'
  }, [activeSession?.name, activeSession?.id])

  return (
    <div className="relative flex h-full bg-[var(--color-bg-primary)]">
      <div className="min-w-0 flex-1">
        <SplitContainer />
      </div>
      {!fullscreenPaneId && <AgentOrchestratorPanel />}
    </div>
  )
}
