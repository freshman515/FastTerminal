import { cn } from '@/lib/utils'
import { usePanesStore, type PaneNode } from '@/stores/panes'
import { PaneView } from './PaneView'
import { ResizeHandle } from './ResizeHandle'

interface SplitNodeProps {
  node: PaneNode
  fullscreenPaneId: string | null
}

function SplitNodeRenderer({ node, fullscreenPaneId }: SplitNodeProps): JSX.Element {
  if (node.type === 'leaf') {
    const isFullscreen = fullscreenPaneId === node.id
    return (
      <div className={cn(isFullscreen ? 'absolute inset-0 z-50' : 'h-full w-full')}>
        <PaneView paneId={node.id} />
      </div>
    )
  }

  const { direction, ratio, first, second } = node
  const isHorizontal = direction === 'horizontal'

  return (
    <div
      className="flex h-full w-full bg-[var(--color-titlebar-bg)]"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div className="rounded-[var(--radius-panel)] overflow-hidden" style={{ flex: `0 0 ${ratio * 100}%`, minWidth: 0, minHeight: 0 }}>
        <SplitNodeRenderer node={first} fullscreenPaneId={fullscreenPaneId} />
      </div>
      <ResizeHandle splitId={node.id} direction={direction} currentRatio={ratio} />
      <div className="rounded-[var(--radius-panel)] overflow-hidden" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <SplitNodeRenderer node={second} fullscreenPaneId={fullscreenPaneId} />
      </div>
    </div>
  )
}

export function SplitContainer(): JSX.Element {
  const root = usePanesStore((s) => s.root)
  const fullscreenPaneId = usePanesStore((s) => s.fullscreenPaneId)

  return (
    <div className="relative h-full w-full">
      <SplitNodeRenderer node={root} fullscreenPaneId={fullscreenPaneId} />
    </div>
  )
}
