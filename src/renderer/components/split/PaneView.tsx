import {
  Columns2,
  Combine,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Rows2,
  Settings,
  Square,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ANONYMOUS_PROJECT_ID } from '@shared/types'
import { cn } from '@/lib/utils'
import {
  usePanesStore,
  registerPaneElement,
  type PaneLayoutPreset,
  type PaneNode,
  type SplitPosition,
} from '@/stores/panes'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { useUIStore } from '@/stores/ui'
import { SessionTab } from '@/components/session/SessionTab'
import { NewSessionMenu } from '@/components/session/NewSessionMenu'
import { TerminalView } from '@/components/session/TerminalView'
import { EmptyState } from '@/components/session/EmptyState'
import { ClaudeCodePanel } from '@/components/rightpanel/ClaudeCodePanel'
import { SessionStatusStrip } from '@/components/layout/SessionStatusStrip'

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
const PANE_ACTION_BUTTON = cn(
  'no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
  'text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]',
  'transition-colors duration-100',
)

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
  const fullscreenPaneId = usePanesStore((s) => s.fullscreenPaneId)
  const applyPaneLayout = usePanesStore((s) => s.applyPaneLayout)
  const balanceSplits = usePanesStore((s) => s.balanceSplits)
  const mergeAllPanes = usePanesStore((s) => s.mergeAllPanes)
  const mergePane = usePanesStore((s) => s.mergePane)
  const togglePaneFullscreen = usePanesStore((s) => s.togglePaneFullscreen)

  const isActivePane = activePaneId === paneId
  const rootType = usePanesStore((s) => s.root.type)
  const isMultiPane = rootType === 'split'
  const showActivePaneBorder = useUIStore((s) => s.settings.showActivePaneBorder)

  const sessions = useMemo(() => {
    return paneSessions
      .map((id) => allSessions.find((s) => s.id === id))
      .filter(Boolean) as typeof allSessions
  }, [paneSessions, allSessions])
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId)
  const paneContextSession = sessions.find((session) => session.id === paneActiveSessionId) ?? sessions[0] ?? null
  const paneProjectId = paneContextSession?.projectId ?? selectedProjectId ?? ANONYMOUS_PROJECT_ID
  const paneWorktreeId = paneContextSession?.worktreeId

  const isTopRightLeaf = paneId === getTopRightLeafId(root)
  const showDetachedWindowControls = isDetached && isTopRightLeaf
  const showMainWindowControls = !isDetached && isTopRightLeaf

  const [showNewMenu, setShowNewMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const [showLayoutMenu, setShowLayoutMenu] = useState(false)
  const [layoutMenuPos, setLayoutMenuPos] = useState({ top: 0, left: 0 })
  const [dropHighlight, setDropHighlight] = useState(false)
  const [edgeDrop, setEdgeDrop] = useState<SplitPosition | 'center' | null>(null)
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null)
  const paneRootRef = useRef<HTMLDivElement>(null)
  const termAreaRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const layoutBtnRef = useRef<HTMLButtonElement>(null)
  const windowDragRef = useRef<WindowDragState | null>(null)
  const currentWindowId = isDetached ? window.api.detach.getWindowId() : 'main'

  const clearHoverOpenTimer = useCallback(() => {
    if (hoverOpenTimerRef.current === null) return
    clearTimeout(hoverOpenTimerRef.current)
    hoverOpenTimerRef.current = null
  }, [])

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current === null) return
    clearTimeout(hoverCloseTimerRef.current)
    hoverCloseTimerRef.current = null
  }, [])

  const updateNewMenuPosition = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 4, left: rect.left })
    }
  }, [])

  const openNewMenu = useCallback(() => {
    clearHoverCloseTimer()
    updateNewMenuPosition()
    setShowNewMenu(true)
  }, [clearHoverCloseTimer, updateNewMenuPosition])

  const closeNewMenu = useCallback(() => {
    clearHoverOpenTimer()
    clearHoverCloseTimer()
    setShowNewMenu(false)
  }, [clearHoverCloseTimer, clearHoverOpenTimer])

  const scheduleNewMenuClose = useCallback(() => {
    clearHoverOpenTimer()
    clearHoverCloseTimer()
    hoverCloseTimerRef.current = setTimeout(() => {
      hoverCloseTimerRef.current = null
      setShowNewMenu(false)
    }, 150)
  }, [clearHoverCloseTimer, clearHoverOpenTimer])

  const handlePlusClick = useCallback((): void => {
    clearHoverOpenTimer()
    clearHoverCloseTimer()
    updateNewMenuPosition()
    setShowNewMenu(!showNewMenu)
  }, [clearHoverCloseTimer, clearHoverOpenTimer, showNewMenu, updateNewMenuPosition])

  const handlePlusMouseEnter = useCallback(() => {
    clearHoverCloseTimer()
    clearHoverOpenTimer()
    hoverOpenTimerRef.current = setTimeout(() => {
      hoverOpenTimerRef.current = null
      openNewMenu()
    }, 500)
  }, [clearHoverCloseTimer, clearHoverOpenTimer, openNewMenu])

  const handleEmptyStateIconClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    clearHoverOpenTimer()
    clearHoverCloseTimer()
    const rect = event.currentTarget.getBoundingClientRect()
    const menuLeft = rect.left + rect.width / 2 - 96
    setMenuPos({
      top: rect.bottom + 8,
      left: Math.max(8, Math.min(menuLeft, window.innerWidth - 200)),
    })
    setShowNewMenu((value) => !value)
  }, [clearHoverCloseTimer, clearHoverOpenTimer])

  const handleLayoutMenuClick = (): void => {
    if (layoutBtnRef.current) {
      const rect = layoutBtnRef.current.getBoundingClientRect()
      setLayoutMenuPos({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)),
      })
    }
    closeNewMenu()
    setShowLayoutMenu((value) => !value)
  }

  const handleQuickSplit = useCallback((position: SplitPosition) => {
    const paneStore = usePanesStore.getState()
    const sessionStore = useSessionsStore.getState()
    const currentSessions = paneStore.paneSessions[paneId] ?? []
    const activeSessionId = paneStore.paneActiveSession[paneId] ?? currentSessions[0] ?? null

    if (!activeSessionId && currentSessions.length === 0) {
      const defaultType = useUIStore.getState().settings.defaultSessionType
      const sessionId = sessionStore.addSession(
        selectedProjectId ?? ANONYMOUS_PROJECT_ID,
        defaultType,
      )
      paneStore.addSessionToPane(paneId, sessionId)
      paneStore.setPaneActiveSession(paneId, sessionId)
      sessionStore.setActive(sessionId)
      return
    }

    let splitSessionId = activeSessionId

    if (currentSessions.length < 2) {
      const activeSession = activeSessionId
        ? sessionStore.sessions.find((session) => session.id === activeSessionId)
        : null
      const defaultType = useUIStore.getState().settings.defaultSessionType
      splitSessionId = sessionStore.addSession(
        activeSession?.projectId ?? selectedProjectId ?? ANONYMOUS_PROJECT_ID,
        defaultType,
        activeSession?.worktreeId,
      )
      paneStore.addSessionToPane(paneId, splitSessionId)
    }

    if (!splitSessionId) return
    paneStore.splitPane(paneId, position, splitSessionId)
    sessionStore.setActive(splitSessionId)
  }, [paneId])

  const handleApplyLayout = useCallback((preset: PaneLayoutPreset) => {
    applyPaneLayout(paneId, preset)
  }, [applyPaneLayout, paneId])

  const handleSmartSplit = useCallback(() => {
    const rect = paneRootRef.current?.getBoundingClientRect()
    const position: SplitPosition = !rect || rect.width >= rect.height * 1.15 ? 'right' : 'down'
    handleQuickSplit(position)
  }, [handleQuickSplit])

  const runLayoutAction = useCallback((action: () => void) => {
    setShowLayoutMenu(false)
    action()
  }, [])

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
    e.preventDefault()
    e.stopPropagation()
    stopWindowDrag()
    if (isDetached) {
      void window.api.detach.maximize()
      return
    }
    void window.api.window.maximize()
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
    const splitDrop = Boolean(zone && zone !== 'center')

    if (splitDrop) {
      store.addSessionToPane(paneId, tabId)
      store.splitPane(paneId, zone, tabId)
    } else {
      store.addSessionToPane(paneId, tabId)
      store.setActivePaneId(paneId)
      store.setPaneActiveSession(paneId, tabId)
    }

    useSessionsStore.getState().setActive(payload.session.id)
    return true
  }, [currentWindowId, paneId])

  const handleTabRowDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!isTabDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropHighlight(true)
  }, [])

  const handleTabRowDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    const nextTarget = e.relatedTarget as Node | null
    if (nextTarget && e.currentTarget.contains(nextTarget)) return
    setDropHighlight(false)
  }, [])

  const handleTabRowDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!isTabDrag(e)) return

    e.preventDefault()
    e.stopPropagation()
    setDropHighlight(false)
    document.body.classList.remove('session-tab-dragging')

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
    if (!sessionId || !sourcePaneId || sourcePaneId === paneId) return

    const store = usePanesStore.getState()
    store.moveSession(sourcePaneId, paneId, sessionId)
    store.setPaneActiveSession(paneId, sessionId)
    useSessionsStore.getState().setActive(sessionId)
  }, [attachDraggedTab, currentWindowId, paneId])

  useEffect(() => {
    registerPaneElement(paneId, paneRootRef.current)
    return () => registerPaneElement(paneId, null)
  }, [paneId])

  useEffect(() => () => stopWindowDrag(), [stopWindowDrag])
  useEffect(() => {
    return () => {
      clearHoverOpenTimer()
      clearHoverCloseTimer()
    }
  }, [clearHoverCloseTimer, clearHoverOpenTimer])

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
          if (e.target !== e.currentTarget) return
          handleWindowDragDoubleClick(e)
        }}
        onDragOver={handleTabRowDragOver}
        onDragLeave={handleTabRowDragLeave}
        onDrop={handleTabRowDrop}
      >
        {/* Scrollable tabs + trailing blank — single flex-1 container so the
            entire strip (gaps, tail whitespace) is a valid drop zone. Do NOT
            add `drag-region` here: CSS `-webkit-app-region: drag` on Electron
            intercepts HTML5 drag-drop events and the tab-bar drop target
            becomes effectively limited to the tab buttons themselves. */}
        <div
          className="tab-strip-drop-zone flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2 pt-1 scrollbar-none no-drag"
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
            onMouseEnter={handlePlusMouseEnter}
            onMouseLeave={scheduleNewMenuClose}
            className={cn(
              'no-drag flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
              'text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]',
              'transition-colors duration-100',
            )}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="no-drag flex shrink-0 items-center self-stretch border-l border-[var(--color-border)] px-1">
          <button
            ref={layoutBtnRef}
            onClick={handleLayoutMenuClick}
            className={cn(
              PANE_ACTION_BUTTON,
              showLayoutMenu && 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]',
            )}
            title="分屏布局"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={() => togglePaneFullscreen(paneId)}
            className={cn(
              PANE_ACTION_BUTTON,
              fullscreenPaneId === paneId && 'bg-[var(--color-accent-muted)] text-[var(--color-text-primary)]',
            )}
            title={fullscreenPaneId === paneId ? '退出 pane 聚焦' : '聚焦当前 pane'}
          >
            {fullscreenPaneId === paneId ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
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
            projectId={paneProjectId}
            worktreeId={paneWorktreeId}
            paneId={paneId}
            onClose={closeNewMenu}
            onMouseEnter={clearHoverCloseTimer}
            onMouseLeave={scheduleNewMenuClose}
            position={menuPos}
          />
        )}

        {showLayoutMenu && createPortal(
          <>
            <div
              className="fixed inset-0"
              style={{ zIndex: 9998 }}
              onClick={() => setShowLayoutMenu(false)}
            />
            <div
              style={{ top: layoutMenuPos.top, left: layoutMenuPos.left, zIndex: 9999 }}
              className={cn(
                'fixed w-[260px] overflow-hidden rounded-[var(--radius-md)]',
                'border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]',
                'shadow-xl shadow-black/40',
              )}
            >
              <div className="border-b border-[var(--color-border)] px-3 py-2">
                <div className="text-[12px] font-medium text-[var(--color-text-primary)]">分屏控制器</div>
                <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                  {sessions.length > 1 ? '拆出当前标签，或重排当前 pane 的标签。' : '新建会话并放到指定方向。'}
                </div>
              </div>

              <div className="p-2">
                <div className="mb-1 px-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">方向</div>
                <div className="grid grid-cols-3 gap-1">
                  <div />
                  <button
                    onClick={() => runLayoutAction(() => handleQuickSplit('up'))}
                    className="flex h-8 items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                    title={sessions.length > 1 ? '拆出当前标签到上方' : '上方新建分屏'}
                  >
                    <SquareSplitVertical size={13} />
                    上
                  </button>
                  <div />
                  <button
                    onClick={() => runLayoutAction(() => handleQuickSplit('left'))}
                    className="flex h-8 items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                    title={sessions.length > 1 ? '拆出当前标签到左侧' : '左侧新建分屏'}
                  >
                    <SquareSplitHorizontal size={13} />
                    左
                  </button>
                  <button
                    onClick={() => runLayoutAction(handleSmartSplit)}
                    className="flex h-8 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-accent-muted)] text-[11px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-accent)]/25"
                    title="根据 pane 宽高自动选择右侧或底部"
                  >
                    智能
                  </button>
                  <button
                    onClick={() => runLayoutAction(() => handleQuickSplit('right'))}
                    className="flex h-8 items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                    title={sessions.length > 1 ? '拆出当前标签到右侧' : '右侧新建分屏'}
                  >
                    <SquareSplitHorizontal size={13} />
                    右
                  </button>
                  <div />
                  <button
                    onClick={() => runLayoutAction(() => handleQuickSplit('down'))}
                    className="flex h-8 items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                    title={sessions.length > 1 ? '拆出当前标签到底部' : '底部新建分屏'}
                  >
                    <SquareSplitVertical size={13} />
                    下
                  </button>
                  <div />
                </div>
              </div>

              {sessions.length >= 2 && (
                <div className="border-t border-[var(--color-border)] p-2">
                  <div className="mb-1 px-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">当前 pane 标签重排</div>
                  <div className="grid grid-cols-3 gap-1">
                    <button
                      onClick={() => runLayoutAction(() => handleApplyLayout('columns'))}
                      className="flex h-8 items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                    >
                      <Columns2 size={13} />
                      两列
                    </button>
                    <button
                      onClick={() => runLayoutAction(() => handleApplyLayout('rows'))}
                      className="flex h-8 items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                    >
                      <Rows2 size={13} />
                      两行
                    </button>
                    <button
                      onClick={() => runLayoutAction(() => handleApplyLayout('grid'))}
                      className="flex h-8 items-center justify-center gap-1 rounded-[var(--radius-sm)] text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                    >
                      <LayoutGrid size={13} />
                      网格
                    </button>
                  </div>
                </div>
              )}

              <div className="border-t border-[var(--color-border)] p-2">
                <div className="mb-1 px-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">布局管理</div>
                <div className="grid gap-1">
                  {isMultiPane && (
                    <>
                      <button
                        onClick={() => runLayoutAction(balanceSplits)}
                        className="flex h-8 items-center justify-between rounded-[var(--radius-sm)] px-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                      >
                        <span>均分所有分屏</span>
                        <span className="text-[10px] font-semibold">1:1</span>
                      </button>
                      <button
                        onClick={() => runLayoutAction(mergeAllPanes)}
                        className="flex h-8 items-center justify-between rounded-[var(--radius-sm)] px-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                      >
                        <span>合并全部分屏</span>
                        <Combine size={13} />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => runLayoutAction(() => togglePaneFullscreen(paneId))}
                    className="flex h-8 items-center justify-between rounded-[var(--radius-sm)] px-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]"
                  >
                    <span>{fullscreenPaneId === paneId ? '退出 pane 聚焦' : '聚焦当前 pane'}</span>
                    {fullscreenPaneId === paneId ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  </button>
                  {isMultiPane && (
                    <button
                      onClick={() => runLayoutAction(() => mergePane(paneId))}
                      className="flex h-8 items-center justify-between rounded-[var(--radius-sm)] px-2 text-[11px] text-[var(--color-error)] hover:bg-[var(--color-error)]/15"
                    >
                      <span>关闭当前 pane</span>
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>,
          document.body,
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
              onIconClick={handleEmptyStateIconClick}
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

      {isMultiPane && (
        <SessionStatusStrip
          paneId={paneId}
          compact
          showSessionBadge
          showActiveBadge
        />
      )}
    </div>
  )
}
