import { usePanesStore, type PaneNode } from '@/stores/panes'
import { PaneView } from './PaneView'
import { ResizeHandle } from './ResizeHandle'

interface SplitNodeProps {
  node: PaneNode
}

function SplitNodeRenderer({ node }: SplitNodeProps): JSX.Element {
  if (node.type === 'leaf') {
    return <PaneView paneId={node.id} />
  }

  const { direction, ratio, first, second } = node
  const isHorizontal = direction === 'horizontal'

  return (
    <div
      className="flex h-full w-full bg-[var(--color-titlebar-bg)]"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div className="rounded-[var(--radius-panel)] overflow-hidden" style={{ flex: `0 0 ${ratio * 100}%`, minWidth: 0, minHeight: 0 }}>
        <SplitNodeRenderer node={first} />
      </div>
      <ResizeHandle splitId={node.id} direction={direction} currentRatio={ratio} />
      <div className="rounded-[var(--radius-panel)] overflow-hidden" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <SplitNodeRenderer node={second} />
      </div>
    </div>
  )
}

function findLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.first, paneId) ?? findLeaf(node.second, paneId)
}

export function SplitContainer(): JSX.Element {
  const root = usePanesStore((s) => s.root)
  const fullscreenPaneId = usePanesStore((s) => s.fullscreenPaneId)

  if (fullscreenPaneId) {
    const fullscreenLeaf = findLeaf(root, fullscreenPaneId)
    if (fullscreenLeaf?.type === 'leaf') {
      return <PaneView paneId={fullscreenLeaf.id} />
    }
  }

  return <SplitNodeRenderer node={root} />
}
