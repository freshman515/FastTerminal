import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Clock, ExternalLink, FolderOpen, GitBranch, Shield, Timer } from 'lucide-react'
import { useSessionsStore } from '@/stores/sessions'
import { usePanesStore } from '@/stores/panes'
import { useUIStore } from '@/stores/ui'
import type { ExternalIdeOption, TerminalShellId } from '@shared/types'

const CONTEXT_MENU_ITEM =
  'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[var(--ui-font-sm)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'

const SHELL_LABELS: Record<TerminalShellId, string> = {
  auto: '自动检测',
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell',
  cmd: 'Command Prompt',
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function formatClock(timestamp: number): string {
  const d = new Date(timestamp)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatUptime(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = s % 60
  if (days > 0) return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`
}

export function StatusBar(): JSX.Element {
  const activePaneId = usePanesStore((s) => s.activePaneId)
  const activeSessionId = usePanesStore((s) => s.paneActiveSession[activePaneId] ?? null)
  const sessions = useSessionsStore((s) => s.sessions)
  const terminalShell = useUIStore((s) => s.settings.terminalShell)
  const addToast = useUIStore((s) => s.addToast)
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null

  const [now, setNow] = useState(Date.now())
  const [branch, setBranch] = useState<string | null>(null)
  const [availableIdes, setAvailableIdes] = useState<ExternalIdeOption[]>([])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const refreshAvailableIdes = useCallback(() => {
    window.api.shell.listIdes().then(setAvailableIdes).catch(() => setAvailableIdes([]))
  }, [])

  useEffect(() => {
    refreshAvailableIdes()
  }, [refreshAvailableIdes])

  // Fetch git branch whenever cwd changes
  useEffect(() => {
    const cwd = activeSession?.cwd
    if (!cwd) {
      setBranch(null)
      return
    }
    let canceled = false
    window.api.shell.getBranch(cwd)
      .then((b) => { if (!canceled) setBranch(b) })
      .catch(() => { if (!canceled) setBranch(null) })
    return () => { canceled = true }
  }, [activeSession?.cwd])

  const cwd = activeSession?.cwd ?? ''
  const uptime = activeSession?.createdAt ? now - activeSession.createdAt : 0

  useEffect(() => {
    setContextMenu(null)
  }, [cwd])

  useEffect(() => {
    if (!contextMenu) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [contextMenu])

  const openCwd = useCallback((): void => {
    if (!cwd) return
    setContextMenu(null)
    void window.api.shell.openPath(cwd)
  }, [cwd])

  const openInIde = useCallback(async (ide: ExternalIdeOption): Promise<void> => {
    if (!cwd) return
    setContextMenu(null)

    const result = await window.api.shell.openInIde(ide.id, cwd)
    if (!result.ok) {
      addToast({
        type: 'error',
        title: `${ide.label} 打开失败`,
        body: result.error ?? '无法启动所选 IDE。',
      })
    }
    refreshAvailableIdes()
  }, [addToast, cwd, refreshAvailableIdes])

  const openAdminShell = useCallback(async (): Promise<void> => {
    if (!cwd) return
    setContextMenu(null)

    addToast({
      type: 'info',
      title: '正在请求管理员权限',
      body: `将在 ${cwd} 打开${SHELL_LABELS[terminalShell]}。`,
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
  }, [addToast, cwd, terminalShell])

  const handlePathContextMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!cwd) return
    event.preventDefault()
    event.stopPropagation()
    refreshAvailableIdes()
    setContextMenu({ x: event.clientX, y: event.clientY })
  }, [cwd, refreshAvailableIdes])

  const estimatedMenuHeight = Math.min(360, 106 + Math.max(availableIdes.length, 1) * 34)
  const contextMenuStyle = contextMenu
    ? {
        left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 248)),
        top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - estimatedMenuHeight - 8)),
      }
    : undefined

  return (
    <div className="flex h-[30px] w-full shrink-0 items-center justify-between gap-5 bg-[var(--color-bg-secondary)] px-4 text-[13px] text-[var(--color-text-tertiary)]">
      <div className="flex min-w-0 items-center gap-4">
        {cwd && (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-1 py-0.5 text-left transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            title={cwd}
            aria-label={`Open ${cwd} in Explorer`}
            onClick={openCwd}
            onContextMenu={handlePathContextMenu}
          >
            <FolderOpen size={13} className="shrink-0" />
            <span className="truncate">{cwd}</span>
          </button>
        )}
        {branch && (
          <div className="flex items-center gap-1.5">
            <GitBranch size={13} className="shrink-0" />
            <span>{branch}</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {activeSession && (
          <div className="flex items-center gap-1.5" title="Session uptime">
            <Timer size={13} />
            <span>{formatUptime(uptime)}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Clock size={13} />
          <span>{formatClock(now)}</span>
        </div>
      </div>
      {contextMenu && contextMenuStyle && createPortal(
        <>
          <div
            className="fixed inset-0 z-[119]"
            onMouseDown={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault()
              setContextMenu(null)
            }}
          />
          <div
            className="no-drag fixed z-[120] max-h-[360px] w-60 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-xl shadow-black/35"
            style={contextMenuStyle}
          >
            <button
              type="button"
              className={CONTEXT_MENU_ITEM}
              onClick={openCwd}
            >
              <span className="flex items-center gap-2">
                <FolderOpen size={13} />
                在资源管理器中打开
              </span>
            </button>
            <button
              type="button"
              className={CONTEXT_MENU_ITEM}
              onClick={() => void openAdminShell()}
            >
              <span className="flex items-center gap-2">
                <Shield size={13} />
                以管理员方式打开终端
              </span>
              <span className="text-[10px] text-[var(--color-text-tertiary)]">
                {SHELL_LABELS[terminalShell]}
              </span>
            </button>
            <div className="my-1 h-px bg-[var(--color-border)]" />
            {availableIdes.length > 0 ? availableIdes.map((ide) => (
              <button
                key={ide.id}
                type="button"
                className={CONTEXT_MENU_ITEM}
                onClick={() => void openInIde(ide)}
              >
                <span>从 {ide.label} 打开</span>
                <ExternalLink size={12} className="text-[var(--color-text-tertiary)]" />
              </button>
            )) : (
              <div className="px-3 py-2 text-[var(--ui-font-sm)] text-[var(--color-text-tertiary)]">
                未找到可用 IDE
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
