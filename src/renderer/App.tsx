import { MainPanel } from '@/components/layout/MainPanel'
import { StatusBar } from '@/components/layout/StatusBar'
import { ToastContainer } from '@/components/notification/ToastContainer'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { PermissionDialog } from '@/components/permission/PermissionDialog'
import { UpdateDialog } from '@/components/update/UpdateDialog'
import { DetachedApp } from '@/DetachedApp'
import { usePanesStore } from '@/stores/panes'
import { useProjectsStore } from '@/stores/projects'
import { useUIStore } from '@/stores/ui'
import { useSessionsStore } from '@/stores/sessions'
import { useWorktreesStore } from '@/stores/worktrees'
import { useClaudeGuiStore } from '@/stores/claudeGui'
import { useActivityMonitor } from '@/hooks/useActivityMonitor'
import { useMcpBridge } from '@/hooks/useMcpBridge'
import { useEffect, useState } from 'react'
import { ANONYMOUS_PROJECT_ID, isClaudeCodeType } from '@shared/types'
import { toggleCurrentSessionFullscreen } from '@/lib/currentSessionFullscreen'
import { playTaskCompleteSound } from '@/lib/notificationSound'
import { cn } from '@/lib/utils'

function getPathLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const label = normalized.split('/').pop()
  return label || path || 'Terminal'
}

function normalizeProjectPath(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

function resolveSessionContextForCwd(cwd?: string): { projectId: string; worktreeId?: string } {
  const projectsStore = useProjectsStore.getState()
  const worktreesStore = useWorktreesStore.getState()
  const normalizedCwd = cwd ? normalizeProjectPath(cwd) : ''

  if (normalizedCwd) {
    const matchedWorktree = worktreesStore.worktrees.find((worktree) => {
      const worktreePath = normalizeProjectPath(worktree.path)
      return normalizedCwd === worktreePath || normalizedCwd.startsWith(`${worktreePath}/`)
    })
    if (matchedWorktree) {
      return {
        projectId: matchedWorktree.projectId,
        ...(matchedWorktree.isMain ? {} : { worktreeId: matchedWorktree.id }),
      }
    }

    const matchedProject = projectsStore.projects.find((project) => {
      const projectPath = normalizeProjectPath(project.path)
      return normalizedCwd === projectPath || normalizedCwd.startsWith(`${projectPath}/`)
    })
    if (matchedProject) {
      return { projectId: matchedProject.id }
    }
  }

  return {
    projectId: projectsStore.selectedProjectId ?? ANONYMOUS_PROJECT_ID,
  }
}

function createTerminalSessionForCwd(cwd?: string): string {
  const sessionStore = useSessionsStore.getState()
  const paneStore = usePanesStore.getState()
  const context = resolveSessionContextForCwd(cwd)
  const sessionId = sessionStore.addSession(context.projectId, 'terminal', context.worktreeId)

  if (cwd) {
    sessionStore.updateSession(sessionId, {
      cwd,
      name: getPathLabel(cwd),
    })
  }

  paneStore.addSessionToPane(paneStore.activePaneId, sessionId)
  paneStore.setPaneActiveSession(paneStore.activePaneId, sessionId)
  sessionStore.setActive(sessionId)
  return sessionId
}

export function App(): JSX.Element {
  // Detached windows render a simplified UI
  if (window.api.detach.isDetached) {
    return <DetachedApp />
  }

  const [ready, setReady] = useState(false)

  // Load only UI settings + custom themes (sessions/panes are NOT persisted).
  // Always start with a single default terminal session.
  useEffect(() => {
    let disposed = false

    void (async () => {
      const data = await window.api.config.read()
      if (disposed) return

      useUIStore.getState()._loadSettings(
        data.ui,
        (data as Record<string, unknown>).customThemes as Record<string, unknown> | undefined,
      )
      useProjectsStore.getState()._loadFromConfig(data.projects)
      useWorktreesStore.getState()._loadFromConfig(
        (data as Record<string, unknown>).worktrees as unknown[] ?? [],
      )
      useClaudeGuiStore.getState()._loadFromConfig(
        (data as Record<string, unknown>).claudeGui as Record<string, unknown> ?? {},
      )

      const initialOpenPaths = await window.api.launch.consumeOpenPaths()
      if (disposed) return

      if (initialOpenPaths.length === 0) {
        createTerminalSessionForCwd()
      } else {
        for (const path of initialOpenPaths) {
          createTerminalSessionForCwd(path)
        }
      }

      setReady(true)
    })()

    return () => { disposed = true }
  }, [])

  useActivityMonitor()
  useMcpBridge()
  const activePaneTabId = usePanesStore((s) => s.paneActiveSession[s.activePaneId] ?? null)

  useEffect(() => {
    if (!ready) return
    let disposed = false

    const openPendingPaths = async (): Promise<void> => {
      const paths = await window.api.launch.consumeOpenPaths()
      if (disposed || paths.length === 0) return
      for (const path of paths) {
        createTerminalSessionForCwd(path)
      }
    }

    const offOpenPathsAvailable = window.api.launch.onOpenPathsAvailable(() => {
      void openPendingPaths()
    })
    void openPendingPaths()

    return () => {
      disposed = true
      offOpenPathsAvailable()
    }
  }, [ready])

  useEffect(() => {
    const sessionStore = useSessionsStore.getState()
    if (!activePaneTabId) {
      if (sessionStore.activeSessionId !== null) sessionStore.setActive(null)
      return
    }
    if (sessionStore.activeSessionId !== activePaneTabId) {
      sessionStore.setActive(activePaneTabId)
    }
    sessionStore.markAsRead(activePaneTabId)
  }, [activePaneTabId])

  useEffect(() => {
    return window.api.claudeGui.onEvent((event) => {
      useClaudeGuiStore.getState().applyEvent(event)
    })
  }, [])

  useEffect(() => {
    return window.api.session.onExit((event) => {
      const sessionStore = useSessionsStore.getState()
      const session = sessionStore.sessions.find((item) => item.ptyId === event.ptyId)
      if (!session) return
      sessionStore.updateSession(session.id, {
        ptyId: null,
        ...(isClaudeCodeType(session.type) && typeof event.resumeUUID === 'string' && event.resumeUUID
          ? { resumeUUID: event.resumeUUID }
          : {}),
      })
      sessionStore.updateStatus(session.id, 'stopped')
    })
  }, [])

  useEffect(() => {
    return window.api.session.onResumeUUIDs((uuids) => {
      const sessionStore = useSessionsStore.getState()
      for (const [sessionId, resumeUUID] of Object.entries(uuids)) {
        if (!resumeUUID) continue
        const session = sessionStore.sessions.find((item) => item.id === sessionId)
        if (!session || session.resumeUUID === resumeUUID) continue
        if (!isClaudeCodeType(session.type)) continue
        sessionStore.updateSession(sessionId, { resumeUUID })
      }
    })
  }, [])

  useEffect(() => {
    return window.api.session.onIdleToast((event) => {
      const session = event.sessionId
        ? useSessionsStore.getState().sessions.find((s) => s.id === event.sessionId)
        : undefined
      const name = session?.name ?? 'Terminal'
      const { notificationToastEnabled, notificationSoundEnabled, notificationSoundVolume } =
        useUIStore.getState().settings
      if (notificationToastEnabled) {
        useUIStore.getState().addToast({
          title: 'Task completed',
          body: name,
          type: 'success',
          sessionId: session?.id,
          duration: 8000,
        })
      }
      if (notificationSoundEnabled) {
        playTaskCompleteSound(notificationSoundVolume)
      }
    })
  }, [])

  useEffect(() => {
    return window.api.detach.onClosed((event) => {
      const paneStore = usePanesStore.getState()
      const sessionStore = useSessionsStore.getState()
      const targetPaneId = event.restorePaneId && paneStore.paneSessions[event.restorePaneId]
        ? event.restorePaneId
        : paneStore.activePaneId

      sessionStore.upsertSessions(event.sessions)

      for (const tabId of event.tabIds) {
        paneStore.addSessionToPane(targetPaneId, tabId)
      }

      const restoredSessionId = event.activeTabId && event.tabIds.includes(event.activeTabId)
        ? event.activeTabId
        : event.tabIds[event.tabIds.length - 1] ?? null
      if (restoredSessionId) {
        paneStore.setActivePaneId(targetPaneId)
        paneStore.setPaneActiveSession(targetPaneId, restoredSessionId)
        sessionStore.setActive(restoredSessionId)
      }

      if (event.projectId) {
        useProjectsStore.getState().selectProject(event.projectId)
      }
      useWorktreesStore.getState().selectWorktree(event.worktreeId ?? null)
    })
  }, [])

  // F11 fullscreen
  useEffect(() => {
    const handleF11 = (e: KeyboardEvent): void => {
      if (e.key !== 'F11') return
      e.preventDefault()
      e.stopPropagation()
      void toggleCurrentSessionFullscreen()
    }
    window.addEventListener('keydown', handleF11, true)
    return () => window.removeEventListener('keydown', handleF11, true)
  }, [])

  // Global shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const sessStore = useSessionsStore.getState()
      const paneStore = usePanesStore.getState()
      const activePaneId = paneStore.activePaneId
      const paneSessions = paneStore.paneSessions[activePaneId] ?? []
      const activeSessionId = paneStore.paneActiveSession[activePaneId] ?? null

      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        sessStore.restoreLastClosed()
        const restored = useSessionsStore.getState()
        const newest = restored.sessions[restored.sessions.length - 1]
        if (newest) paneStore.addSessionToPane(activePaneId, newest.id)
        return
      }

      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        if (paneSessions.length <= 1) return
        const activeIdx = activeSessionId ? paneSessions.indexOf(activeSessionId) : 0
        const direction = e.shiftKey ? -1 : 1
        const startIdx = activeIdx >= 0 ? activeIdx : 0
        const nextIdx = (startIdx + direction + paneSessions.length) % paneSessions.length
        paneStore.setPaneActiveSession(activePaneId, paneSessions[nextIdx])
        return
      }

      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault()
        if (activeSessionId) {
          const session = sessStore.sessions.find((s) => s.id === activeSessionId)
          if (session?.pinned) return
          if (session?.ptyId) window.api.session.kill(session.ptyId)
          paneStore.removeSessionFromPane(activePaneId, activeSessionId)
          sessStore.removeSession(activeSessionId)
        }
        return
      }

      if (e.ctrlKey && e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault()
        const dir = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowUp' ? 'up' : 'down'
        paneStore.navigatePane(dir)
        return
      }

      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = Number(e.key) - 1
        if (idx < paneSessions.length) {
          paneStore.setPaneActiveSession(activePaneId, paneSessions[idx])
        }
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    window.api.window.isFullscreen().then((fullscreen) => {
      useUIStore.getState().setWindowFullscreen(fullscreen)
    }).catch(() => {})
  }, [])

  const fullscreenPaneId = usePanesStore((s) => s.fullscreenPaneId)
  const isMultiPane = usePanesStore((s) => s.root.type === 'split')
  const windowFullscreen = useUIStore((s) => s.windowFullscreen)

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-bg-primary)]">
        <div className="text-xs text-[var(--color-text-tertiary)]">Loading...</div>
      </div>
    )
  }

  const hideChrome = windowFullscreen || Boolean(fullscreenPaneId)

  return (
    <div className="flex h-full flex-col bg-[var(--color-titlebar-bg)]">
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <MainPanel />
        </div>
      </div>

      {!hideChrome && !isMultiPane && <StatusBar />}

      <SettingsDialog />
      <PermissionDialog />
      <UpdateDialog />
      <ToastContainer />
    </div>
  )
}
