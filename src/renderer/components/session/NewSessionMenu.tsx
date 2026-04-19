import { useCallback, useEffect, useRef } from 'react'
import { Shield } from 'lucide-react'
import type { SessionType } from '@shared/types'
import { cn } from '@/lib/utils'
import { getDefaultWorktreeIdForProject } from '@/lib/project-context'
import { useSessionsStore } from '@/stores/sessions'
import { usePanesStore } from '@/stores/panes'
import { useUIStore, type NewSessionMenuItemId } from '@/stores/ui'
import claudeIcon from '@/assets/icons/Claude.png'
import codexIcon from '@/assets/icons/codex.png'
import opencodeIcon from '@/assets/icons/icon-opencode.png'
import terminalIcon from '@/assets/icons/terminal_white.png'

interface SessionOption {
  id: NewSessionMenuItemId
  type: SessionType
  label: string
  icon: string
}

const SESSION_OPTIONS: SessionOption[] = [
  { id: 'claude-code', type: 'claude-code', label: 'Claude Code', icon: claudeIcon },
  { id: 'claude-code-yolo', type: 'claude-code-yolo', label: 'Claude Code YOLO', icon: claudeIcon },
  { id: 'codex', type: 'codex', label: 'Codex', icon: codexIcon },
  { id: 'codex-yolo', type: 'codex-yolo', label: 'Codex YOLO', icon: codexIcon },
  { id: 'opencode', type: 'opencode', label: 'OpenCode', icon: opencodeIcon },
]
const SESSION_OPTION_BY_ID = new Map(SESSION_OPTIONS.map((option) => [option.id, option]))

interface NewSessionMenuProps {
  projectId: string
  paneId?: string
  onClose: () => void
  position: { top: number; left: number }
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function NewSessionMenu({
  projectId,
  paneId,
  onClose,
  position,
  onMouseEnter,
  onMouseLeave,
}: NewSessionMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const addSession = useSessionsStore((s) => s.addSession)
  const addSessionToPane = usePanesStore((s) => s.addSessionToPane)
  const terminalShell = useUIStore((s) => s.settings.terminalShell)
  const visibleMenuItems = useUIStore((s) => s.settings.newSessionMenuItems)
  const addToast = useUIStore((s) => s.addToast)

  const handleSelect = useCallback(
    (type: SessionType) => {
      const worktreeId = getDefaultWorktreeIdForProject(projectId)
      const id = addSession(projectId, type, worktreeId)
      const targetPane = paneId ?? usePanesStore.getState().activePaneId
      addSessionToPane(targetPane, id)
      onClose()
    },
    [projectId, paneId, addSession, addSessionToPane, onClose],
  )

  const resolveTargetCwd = useCallback(async (): Promise<string> => {
    const paneStore = usePanesStore.getState()
    const sessionStore = useSessionsStore.getState()
    const targetPane = paneId ?? paneStore.activePaneId
    const activeSessionId = paneStore.paneActiveSession[targetPane] ?? sessionStore.activeSessionId
    const activeSession = sessionStore.sessions.find((session) => session.id === activeSessionId)
    if (activeSession?.cwd) return activeSession.cwd

    const firstSessionWithCwd = sessionStore.sessions.find((session) => Boolean(session.cwd))
    if (firstSessionWithCwd?.cwd) return firstSessionWithCwd.cwd

    return window.api.config.getAnonymousWorkspace()
  }, [paneId])

  const handleAdminTerminal = useCallback(async () => {
    onClose()
    const cwd = await resolveTargetCwd()
    addToast({
      type: 'info',
      title: '正在请求管理员权限',
      body: `将在 ${cwd} 打开管理员终端。`,
      duration: 4000,
    })

    const result = await window.api.shell.openAdminTerminal(cwd, terminalShell)
    if (!result.ok) {
      addToast({
        type: 'error',
        title: '管理员终端打开失败',
        body: result.error ?? '无法启动管理员终端。',
      })
      return
    }

    addToast({
      type: 'success',
      title: '已请求打开管理员终端',
      body: '如果启用了 UAC，请确认系统权限提示。',
    })
  }, [addToast, onClose, resolveTargetCwd, terminalShell])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && menuRef.current?.contains(target)) return
      onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [onClose])

  const renderMenuItem = (id: NewSessionMenuItemId): JSX.Element | null => {
    if (id === 'terminal') {
      return (
        <button
          key={id}
          onClick={() => handleSelect('terminal')}
          className={cn(
            'flex w-full items-center gap-2.5 px-3 py-2',
            'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]',
            'transition-colors duration-75',
          )}
        >
          <img src={terminalIcon} alt="" className="h-4 w-4 shrink-0" />
          <span className="text-[var(--ui-font-sm)] font-medium">终端</span>
        </button>
      )
    }

    if (id === 'admin-terminal') {
      return (
        <button
          key={id}
          onClick={() => void handleAdminTerminal()}
          className={cn(
            'flex w-full items-center gap-2.5 px-3 py-2',
            'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]',
            'transition-colors duration-75',
          )}
        >
          <Shield size={16} className="shrink-0 text-[var(--color-warning)]" />
          <span className="text-[var(--ui-font-sm)] font-medium">终端（管理员）</span>
        </button>
      )
    }

    const opt = SESSION_OPTION_BY_ID.get(id)
    if (!opt) return null
    return (
      <button
        key={id}
        onClick={() => handleSelect(opt.type)}
        className={cn(
          'flex w-full items-center gap-2.5 px-3 py-2',
          'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)] hover:text-[var(--color-text-primary)]',
          'transition-colors duration-75',
        )}
      >
        <img src={opt.icon} alt="" className="h-4 w-4 shrink-0" />
        <span className="text-[var(--ui-font-sm)] font-medium">{opt.label}</span>
      </button>
    )
  }

  return (
    <>
      <div
        ref={menuRef}
        style={{ top: position.top, left: position.left }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className={cn(
          'fixed z-50 w-48 rounded-[var(--radius-md)] py-1',
          'border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]',
          'shadow-lg shadow-black/30 animate-[fade-in_0.1s_ease-out]',
        )}
      >
        {visibleMenuItems.map(renderMenuItem)}
      </div>
    </>
  )
}
