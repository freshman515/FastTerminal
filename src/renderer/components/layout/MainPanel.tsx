import { useEffect } from 'react'
import { useSessionsStore } from '@/stores/sessions'
import { usePanesStore } from '@/stores/panes'
import { SplitContainer } from '@/components/split/SplitContainer'

export function MainPanel(): JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions)
  const activeTabId = usePanesStore((s) => s.paneActiveSession[s.activePaneId] ?? null)

  const activeSession = sessions.find((s) => s.id === activeTabId)
  useEffect(() => {
    document.title = activeSession ? `${activeSession.name} — FastTerminal` : 'FastTerminal'
  }, [activeSession?.name, activeSession?.id])

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      <SplitContainer />
    </div>
  )
}
