import { usePanesStore } from '@/stores/panes'
import { SessionStatusStrip } from './SessionStatusStrip'

export function StatusBar(): JSX.Element {
  const activePaneId = usePanesStore((s) => s.activePaneId)
  return <SessionStatusStrip paneId={activePaneId} />
}
