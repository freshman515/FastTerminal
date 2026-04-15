import { Minus, Plus, Settings, Square, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { usePanesStore, registerPaneElement, type PaneNode, type SplitPosition } from '@/stores/panes'
import { useSessionsStore } from '@/stores/sessions'
import { useUIStore } from '@/stores/ui'
import { SessionTab } from '@/components/session/SessionTab'
import { NewSessionMenu } from '@/components/session/NewSessionMenu'
import { TerminalView } from '@/components/session/TerminalView'
import { EmptyState } from '@/components/session/EmptyState'
import { ClaudeCodePanel } from '@/components/rightpanel/ClaudeCodePanel'

interface PaneViewProps {
  paneId: string
}

interface WindowDragState {
  startMouseX: number
  startMouseY: number
  startWindowX: number
  startWindowY: number
  pendingX: number
  pendingY: number
  frameId: number | null
  handleMouseMove: (event: MouseEvent) => void
  handleMouseUp: () => void
}

const isDetached = window.api.detach.isDetached

function isTabDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('session-tab-id') || e.dataTransfer.types.includes('session-tab-drag-token')
}

type DetachedTabDragPayload = {
  kind: 'session'
  session: ReturnType<typeof useSessionsStore.getState>['sessions'][number]
  sourcePaneId: string
  sourceWindowId: string
}

function getTopRightLeafId(node: PaneNode): string {
  if (node.type === 'leaf') return node.id
  return node.direction === 'horizontal'
    ? getTopRightLeafId(node.second)
    : getTopRightLeafId(node.first)
}

export function PaneView({ paneId }: PaneViewProps): JSX.Element {
  const activePaneId = usePanesStore((s) => s.activePaneId)
  const setActivePaneId = usePanesStore((s) => s.setActivePaneId)
  const root = usePanesStore((s) => s.root)
  const paneSessions = usePanesStore((s) => s.paneSessions[paneId] ?? [])
  const paneActiveSessionId = usePanesStore((s) => s.paneActiveSession[paneId] ?? null)
  const allSessions = useSessionsStore((s) => s.sessions)

  const isActivePane = activePaneId === paneId
  const rootType = usePanesStore((s) => s.root.type)
  const isMultiPane = rootType === 'split'
  const showActivePaneBorder = useUIStore((s) => s.settings.showActivePaneBorder)

  const sessions = useMemo(() => {
    return paneSessions
      .map((id) => allSessions.find((s) => s.id === id))
      .filter(Boolean) as typeof allSessions
  }, [paneSessions, allSessions])

  const isTopRightLeaf = paneId === getTopRightLeafId(root)
  const showDetachedWindowControls = isDetached && isTopRightLeaf
  const showMainWindowControls = !isDetached && isTopRightLeaf

  const [showNewMenu, setShowNewMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const [dropHighlight, setDropHighlight] = useState(false)
  const [edgeDrop, setEdgeDrop] = useState<SplitPosition | 'center' | null>(null)
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null)
  const termAreaRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const windowDragRef = useRef<WindowDragState | null>(null)
  const currentWindowId = isDetached ? window.api.detach.getWindowId() : 'main'

  const handlePlusClick = (): void => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 4, left: rect.left })
    }
    setShowNewMenu(!showNewMenu)
  }

  const paneRootRef = useRef<HTMLDivElement>(null)

  const handleFocus = useCallback(() => {
    if (!isActivePane) setActivePaneId(paneId)
  }, [isActivePane, paneId, setActivePaneId])

  const stopWindowDrag = useCallback(() => {
    const drag = windowDragRef.current
    if (!drag) return
    if (drag.frameId !== null) {
      cancelAnimationFrame(drag.frameId)
    }
    window.removeEventListener('mousemove', drag.handleMouseMove)
    window.removeEventListener('mouseup', drag.handleMouseUp)
    document.body.style.cursor = ''
    windowDragRef.current = null
  }, [])

  const handleWindowDragMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!isDetached || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    stopWindowDrag()

    const dragState: WindowDragState = {
      startMouseX: e.screenX,
      startMouseY: e.screenY,
      startWindowX: window.screenX,
      startWindowY: window.screenY,
      pendingX: window.screenX,
      pendingY: window.screenY,
      frameId: null,
      handleMouseMove: () => {},
      handleMouseUp: () => {},
    }

    dragState.handleMouseMove = (moveEvent: MouseEvent) => {
      if (moveEvent.buttons === 0) {
        stopWindowDrag()
        return
      }
      dragState.pendingX = dragState.startWindowX + (moveEvent.screenX - dragState.startMouseX)
      dragState.pendingY = dragState.startWindowY + (moveEvent.screenY - dragState.startMouseY)
      if (dragState.frameId !== null) return
      dragState.frameId = requestAnimationFrame(() => {
        dragState.frameId = null
        void window.api.detach.setPosition(dragState.pendingX, dragState.pendingY)
      })
    }

    dragState.handleMouseUp = () => { stopWindowDrag() }

    windowDragRef.current = dragState
    window.addEventListener('mousemove', dragState.handleMouseMove)
    window.addEventListener('mouseup', dragState.handleMouseUp)
  }, [stopWindowDrag])

  const handleWindowDragDoubleClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!isDetached) return
    e.preventDefault()
    e.stopPropagation()
    stopWindowDrag()
    void window.api.detach.maximize()
  }, [stopWindowDrag])

  const handleTopBarBlankMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    handleWindowDragMouseDown(e)
  }, [handleWindowDragMouseDown])

  const handleTopBarBlankDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    handleWindowDragDoubleClick(e)
  }, [handleWindowDragDoubleClick])

  const attachDraggedTab = useCallback((dragToken: string, zone?: SplitPosition | 'center' | null) => {
    const payload = window.api.detach.claimTabDrag(dragToken, currentWindowId) as DetachedTabDragPayload | null
    if (!payload) return false

    const tabId = payload.session.id
    useSessionsStore.getState().upsertSessions([payload.session])
    const store = usePanesStore.getState()

    if (zone && zone !== 'center') {
      store.addSessionToPane(paneId, tabId)
      store.splitPane(paneId, zone, tabId)
    } else {
      store.addSessionToPane(paneId, tabId)
    }

    store.setActivePaneId(paneId)
    store.setPaneActiveSession(paneId, tabId)
    useSessionsStore.getState().setActive(payload.session.id)
    return true
  }, [currentWindowId, paneId])

  useEffect(() => {
    registerPaneElement(paneId, paneRootRef.current)
    return () => registerPaneElement(paneId, null)
  }, [paneId])

  useEffect(() => () => stopWindowDrag(), [stopWindowDrag])

  return (
    <div
      ref={paneRootRef}
      className={cn(
        'relative flex h-full flex-col',
        isMultiPane && !showActivePaneBorder && 'border border-transparent',
      )}
      onMouseDown={handleFocus}
    >
      {isMultiPane && showActivePaneBorder && isActivePane && (
        <div className="pointer-events-none absolute inset-0 z-50 rounded-[var(--radius-panel)] border-2 border-[var(--color-accent)]/60" />
      )}

      <div
        className={cn(
          'tab-bar relative flex shrink-0 items-end bg-[var(--color-bg-secondary)]',
          dropHighlight && 'ring-2 ring-inset ring-[var(--color-accent)]',
        )}
        style={{ height: 40 }}
        onWheel={(e) => {
          if (sessions.length === 0) return
          const activeIdx = sessions.findIndex((s) => s.id === paneActiveSessionId)
          const dir = e.deltaY > 0 ? 1 : -1
          const next = (activeIdx + dir + sessions.length) % sessions.length
          usePanesStore.getState().setPaneActiveSession(paneId, sessions[next].id)
        }}
        onDoubleClick={(e) => {
          if (isDetached || e.target !== e.currentTarget) return
          const defaultType = useUIStore.getState().settings.defaultSessionType
          const id = useSessionsStore.getState().addSession('default', defaultType)
          usePanesStore.getState().addSessionToPane(paneId, id)
        }}
        onDragOver={(e) => {
          if (isTabDrag(e)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropHighlight(true)
          }
        }}
        onDragLeave={() => setDropHighlight(false)}
        onDrop={(e) => {
          setDropHighlight(false)
          const sessionId = e.dataTransfer.getData('session-tab-id')
          const sourcePaneId = e.dataTransfer.getData('source-pane-id')
          const sourceWindowId = e.dataTransfer.getData('source-window-id') || 'main'
          const dragToken = e.dataTransfer.getData('session-tab-drag-token')
            || window.api.detach.getActiveTabDrag()
          if (dragToken && sourceWindowId !== currentWindowId) {
            attachDraggedTab(dragToken)
            return
          }
          if (sourceWindowId !== currentWindowId && !dragToken) return
          if (!sessionId && dragToken) {
            attachDraggedTab(dragToken)
            return
          }
          if (sessionId && sourcePaneId && sourcePaneId !== paneId) {
            usePanesStore.getState().moveSession(sourcePaneId, paneId, sessionId)
          }
        }}
      >
        <div
          className={cn(
            'flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2 pt-1 scrollbar-none',
            !isDetached && 'drag-region',
          )}
          style={{ position: 'relative', zIndex: 1 }}
          onMouseDown={handleTopBarBlankMouseDown}
          onDoubleClick={handleTopBarBlankDoubleClick}
        >
          {sessions.map((session, index) => (
            <SessionTab
              key={session.id}
              session={session}
              isActive={session.id === paneActiveSessionId}
              isPaneFocused={isActivePane}
              paneId={paneId}
              isDragging={dragTabId === session.id}
              showDivider={index < sessions.length - 1}
              dropSide={dropTargetId === session.id ? dropSide : null}
              onDragStart={(id) => setDragTabId(id)}
              onDragOver={(id, e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                const mid = rect.left + rect.width / 2
                setDropTargetId(id)
                setDropSide(e.clientX < mid ? 'left' : 'right')
              }}
              onDragLeave={() => { setDropTargetId(null); setDropSide(null) }}
              onDrop={(id) => {
                if (dragTabId && dragTabId !== id) {
                  usePanesStore.getState().reorderPaneSessions(paneId, dragTabId, id)
                }
                setDropTargetId(null); setDropSide(null)
              }}
              onDragEnd={() => { setDragTabId(null); setDropTargetId(null); setDropSide(null) }}
            />
          ))}

          <button
            ref={btnRef}
            onClick={handlePlusClick}
            className={cn(
              'no-drag flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
              'text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]',
              'transition-colors duration-100',
            )}
            title="New Session"
          >
            <Plus size={14} />
          </button>

          {usePanesStore.getState().root.type === 'split' && (
            <button
              onClick={() => usePanesStore.getState().mergePane(paneId)}
              className={cn(
                'no-drag flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
                'text-[var(--color-text-tertiary)] hover:bg-[var(--color-error)]/20 hover:text-[var(--color-error)]',
                'transition-colors duration-100',
              )}
              title="Close Pane"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {showDetachedWindowControls && (
          <div className="no-drag ml-auto flex shrink-0 items-center self-stretch">
            <button onClick={() => window.api.detach.minimize()} className="flex h-full w-10 items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
              <Minus size={14} />
            </button>
            <button onClick={() => window.api.detach.maximize()} className="flex h-full w-10 items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
              <Square size={11} />
            </button>
            <button onClick={() => window.api.detach.close()} className="flex h-full w-10 items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-error)] hover:text-white transition-colors">
              <X size={14} />
            </button>
          </div>
        )}
        {showMainWindowControls && (
          <div className="no-drag ml-auto flex shrink-0 items-center self-stretch">
            <button
              onClick={() => useUIStore.getState().openSettings()}
              className="flex h-full w-10 items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              title="Settings"
            >
              <Settings size={14} />
            </button>
            <button onClick={() => window.api.window.minimize()} className="flex h-full w-10 items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
              <Minus size={14} />
            </button>
            <button onClick={() => window.api.window.maximize()} className="flex h-full w-10 items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
              <Square size={11} />
            </button>
            <button onClick={() => window.api.window.close()} className="flex h-full w-10 items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-error)] hover:text-white transition-colors">
              <X size={14} />
            </button>
          </div>
        )}

        {showNewMenu && (
          <NewSessionMenu
            projectId="default"
            paneId={paneId}
            onClose={() => setShowNewMenu(false)}
            position={menuPos}
          />
        )}
      </div>

      <div
        ref={termAreaRef}
        className="relative flex-1 overflow-hidden bg-[var(--color-bg-primary)]"
        onDragOver={(e) => {
          if (!isTabDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const rect = termAreaRef.current?.getBoundingClientRect()
          if (!rect) return
          const x = (e.clientX - rect.left) / rect.width
          const y = (e.clientY - rect.top) / rect.height
          const edge = 0.25
          if (x < edge) setEdgeDrop('left')
          else if (x > 1 - edge) setEdgeDrop('right')
          else if (y < edge) setEdgeDrop('up')
          else if (y > 1 - edge) setEdgeDrop('down')
          else setEdgeDrop('center')
        }}
        onDragLeave={() => setEdgeDrop(null)}
        onDrop={(e) => {
          const zone = edgeDrop
          setEdgeDrop(null)
          const sessionId = e.dataTransfer.getData('session-tab-id')
          const sourcePaneId = e.dataTransfer.getData('source-pane-id')
          const sourceWindowId = e.dataTransfer.getData('source-window-id') || 'main'
          const dragToken = e.dataTransfer.getData('session-tab-drag-token')
            || window.api.detach.getActiveTabDrag()
          if (dragToken && (sourceWindowId !== currentWindowId || !sessionId)) {
            attachDraggedTab(dragToken, zone)
            return
          }
          if (sourceWindowId !== currentWindowId && !dragToken) return
          if (!sessionId || !sourcePaneId) return
          const store = usePanesStore.getState()

          if (zone && zone !== 'center') {
            if (sourcePaneId === paneId) {
              store.splitPane(paneId, zone, sessionId)
            } else {
              store.addSessionToPane(paneId, sessionId)
              store.removeSessionFromPane(sourcePaneId, sessionId)
              store.splitPane(paneId, zone, sessionId)
            }
          } else if (sourcePaneId !== paneId) {
            store.moveSession(sourcePaneId, paneId, sessionId)
          }
        }}
      >
        {sessions.map((session) => {
          const isActive = session.id === paneActiveSessionId
          return (
            <div
              key={session.id}
              className="absolute inset-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                zIndex: isActive ? 1 : 0,
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            >
              {session.type === 'claude-gui'
                ? <ClaudeCodePanel sessionId={session.id} />
                : <TerminalView session={session} isActive={isActive && isActivePane} />}
            </div>
          )
        })}

        {sessions.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <EmptyState
              title="Empty pane"
              description="Create a session or drag a tab here."
            />
          </div>
        )}

        {edgeDrop && edgeDrop !== 'center' && (
          <div
            className="absolute bg-[var(--color-accent)]/15 border-2 border-[var(--color-accent)]/40 pointer-events-none"
            style={{
              zIndex: 50,
              ...(edgeDrop === 'left' ? { left: 0, top: 0, width: '50%', height: '100%' } :
                edgeDrop === 'right' ? { right: 0, top: 0, width: '50%', height: '100%' } :
                edgeDrop === 'up' ? { left: 0, top: 0, width: '100%', height: '50%' } :
                { left: 0, bottom: 0, width: '100%', height: '50%' }),
            }}
          />
        )}
        {edgeDrop === 'center' && (
          <div
            className="absolute inset-2 rounded-[var(--radius-md)] bg-[var(--color-accent)]/10 border-2 border-dashed border-[var(--color-accent)]/30 pointer-events-none"
            style={{ zIndex: 50 }}
          />
        )}
      </div>
    </div>
  )
}
