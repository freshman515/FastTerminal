import { useCallback, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { usePanesStore } from '@/stores/panes'

interface ResizeHandleProps {
  splitId: string
  direction: 'horizontal' | 'vertical'
  currentRatio: number
}

const SNAP_POINTS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75]

function clampRatio(ratio: number): number {
  return Math.max(0.15, Math.min(0.85, ratio))
}

function snapRatio(ratio: number): number {
  let closest = SNAP_POINTS[0]
  let closestDistance = Math.abs(ratio - closest)

  for (const point of SNAP_POINTS.slice(1)) {
    const distance = Math.abs(ratio - point)
    if (distance < closestDistance) {
      closest = point
      closestDistance = distance
    }
  }

  return closest
}

export function ResizeHandle({ splitId, direction, currentRatio }: ResizeHandleProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const savedRatioRef = useRef<number | null>(null)
  const resizeSplit = usePanesStore((s) => s.resizeSplit)
  const beginSplitResize = usePanesStore((s) => s.beginSplitResize)
  const endSplitResize = usePanesStore((s) => s.endSplitResize)
  const [dragRatio, setDragRatio] = useState<number | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const parentEl = containerRef.current?.parentElement
      if (!parentEl) return

      const parentRect = parentEl.getBoundingClientRect()
      beginSplitResize()
      setDragRatio(Math.round(currentRatio * 100))

      const handleMouseMove = (ev: MouseEvent): void => {
        let ratio: number
        if (direction === 'horizontal') {
          ratio = (ev.clientX - parentRect.left) / parentRect.width
        } else {
          ratio = (ev.clientY - parentRect.top) / parentRect.height
        }
        const nextRatio = clampRatio(ev.shiftKey ? snapRatio(ratio) : ratio)
        setDragRatio(Math.round(nextRatio * 100))
        resizeSplit(splitId, nextRatio)
      }

      const handleMouseUp = (): void => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setDragRatio(null)
        endSplitResize()
      }

      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [splitId, direction, currentRatio, resizeSplit, beginSplitResize, endSplitResize],
  )

  const handleDoubleClick = useCallback(() => {
    // Toggle between maximized first pane and restore
    if (savedRatioRef.current !== null) {
      // Restore saved ratio
      resizeSplit(splitId, savedRatioRef.current)
      savedRatioRef.current = null
    } else {
      // Save current ratio, maximize first pane
      savedRatioRef.current = currentRatio
      resizeSplit(splitId, 0.85)
    }
  }, [splitId, currentRatio, resizeSplit])

  const isHorizontal = direction === 'horizontal'

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      className={cn(
        'group shrink-0 bg-[var(--color-titlebar-bg)]',
        isHorizontal ? 'w-[var(--layout-gap)] cursor-col-resize' : 'h-[var(--layout-gap)] cursor-row-resize',
        'relative',
        dragRatio !== null && 'bg-[var(--color-accent)]/20',
      )}
    >
      <div
        className={cn(
          'absolute z-10',
          isHorizontal
            ? 'inset-y-0 -left-1.5 -right-1.5 group-hover:bg-[var(--color-accent)]/30'
            : 'inset-x-0 -top-1.5 -bottom-1.5 group-hover:bg-[var(--color-accent)]/30',
          'transition-colors duration-75',
        )}
      />
      {dragRatio !== null && (
        <div
          className={cn(
            'pointer-events-none absolute z-20 rounded-[var(--radius-sm)] border border-[var(--color-border)]',
            'bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-primary)]',
            'shadow-lg shadow-black/30',
            'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
          )}
        >
          {dragRatio}%
        </div>
      )}
    </div>
  )
}
