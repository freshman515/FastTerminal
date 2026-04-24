import { useEffect, useRef } from 'react'
import { switchProjectContext } from '@/lib/project-context'
import { usePanesStore } from '@/stores/panes'
import { useSessionsStore } from '@/stores/sessions'
import { useProjectsStore } from '@/stores/projects'
import { useUIStore } from '@/stores/ui'
import { updateAgentStatus } from '@/components/rightpanel/agentRuntime'
import { addTimelineEvent } from '@/components/rightpanel/SessionTimeline'

const POLL_INTERVAL = 2000
const IDLE_THRESHOLD = 2

export function useActivityMonitor(): void {
  const idleCountsRef = useRef<Record<string, number>>({})

  // Single polling effect - uses getState() to avoid re-render loops
  useEffect(() => {
    const interval = setInterval(async () => {
      const { sessions, outputStates, activeSessionId, updateStatus, setOutputState } =
        useSessionsStore.getState()
      const panesState = usePanesStore.getState()
      const attachedSessionIds = new Set(Object.values(panesState.paneSessions).flat())
      const visibleSessionIds = panesState.fullscreenPaneId
        ? new Set(
            [panesState.paneActiveSession[panesState.fullscreenPaneId]].filter(
              (sessionId): sessionId is string => Boolean(sessionId),
            ),
          )
        : new Set(
            Object.values(panesState.paneActiveSession).filter((sessionId): sessionId is string => Boolean(sessionId)),
          )
      const runningSessions = sessions.filter(
        (session) => session.status === 'running' && session.ptyId && attachedSessionIds.has(session.id),
      )
      const runningSessionIds = new Set(runningSessions.map((session) => session.id))
      for (const sessionId of Object.keys(idleCountsRef.current)) {
        if (!runningSessionIds.has(sessionId)) {
          delete idleCountsRef.current[sessionId]
        }
      }

      for (const session of runningSessions) {
        if (!session.ptyId) continue

        try {
          const active = await window.api.session.getActivity(session.ptyId)

          if (active) {
            idleCountsRef.current[session.id] = 0
          } else {
            const count = (idleCountsRef.current[session.id] ?? 0) + 1
            idleCountsRef.current[session.id] = count

            if (count >= IDLE_THRESHOLD && outputStates[session.id] === 'outputting') {
              const isViewing = visibleSessionIds.has(session.id) || activeSessionId === session.id
              setOutputState(session.id, isViewing ? 'idle' : 'unread')
              updateStatus(session.id, 'idle')
              updateAgentStatus(session.id, 'idle')
              addTimelineEvent(session.id, 'idle', 'Session became idle')

              if (!isViewing && useUIStore.getState().settings.notificationToastEnabled) {
                const project = useProjectsStore
                  .getState()
                  .projects.find((p) => p.id === session.projectId)
                useUIStore.getState().addToast({
                  title: `${session.name} completed`,
                  body: project ? `Project: ${project.name}` : undefined,
                  type: 'info',
                  sessionId: session.id,
                  projectId: session.projectId,
                })

                window.api.notification.show({
                  title: `${session.name} completed`,
                  body: project ? `Project: ${project.name}` : '',
                  sessionId: session.id,
                  projectId: session.projectId,
                })
              }
            }
          }
        } catch {
          // Session may have been destroyed
        }
      }
    }, POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [])

  // Listen for system notification clicks
  useEffect(() => {
    return window.api.notification.onClick((data) => {
      if (data.sessionId) {
        const session = useSessionsStore.getState().sessions.find((s) => s.id === data.sessionId)
        if (session) {
          switchProjectContext(session.projectId, session.id, session.worktreeId ?? null)
          const paneStore = usePanesStore.getState()
          const paneId = Object.entries(paneStore.paneSessions)
            .find(([, sessionIds]) => sessionIds.includes(session.id))?.[0]
          if (paneId) {
            paneStore.setActivePaneId(paneId)
            paneStore.setPaneActiveSession(paneId, session.id)
          }
        } else if (data.projectId) {
          useProjectsStore.getState().selectProject(data.projectId)
        }
        useSessionsStore.getState().setActive(data.sessionId)
        useSessionsStore.getState().markAsRead(data.sessionId)
      } else if (data.projectId) {
        useProjectsStore.getState().selectProject(data.projectId)
      }
    })
  }, [])

  // Listen for session exit events
  useEffect(() => {
    return window.api.session.onExit((event) => {
      const { sessions, activeSessionId } = useSessionsStore.getState()
      const panesState = usePanesStore.getState()
      const attachedSessionIds = new Set(Object.values(panesState.paneSessions).flat())
      const visibleSessionIds = panesState.fullscreenPaneId
        ? new Set(
            [panesState.paneActiveSession[panesState.fullscreenPaneId]].filter(
              (sessionId): sessionId is string => Boolean(sessionId),
            ),
          )
        : new Set(
            Object.values(panesState.paneActiveSession).filter((sessionId): sessionId is string => Boolean(sessionId)),
          )
      const session = sessions.find((s) => s.ptyId === event.ptyId)
      if (!session) return
      if (!attachedSessionIds.has(session.id)) return
      updateAgentStatus(session.id, 'stopped')
      addTimelineEvent(session.id, event.exitCode === 0 ? 'stop' : 'error', `Exited with code ${event.exitCode}`)

      const isViewing = visibleSessionIds.has(session.id) || activeSessionId === session.id
      if (!isViewing && useUIStore.getState().settings.notificationToastEnabled) {
        const project = useProjectsStore
          .getState()
          .projects.find((p) => p.id === session.projectId)
        useUIStore.getState().addToast({
          title: `${session.name} exited`,
          body: `Exit code: ${event.exitCode}${project ? ` | ${project.name}` : ''}`,
          type: event.exitCode === 0 ? 'success' : 'warning',
          sessionId: session.id,
          projectId: session.projectId,
        })
      }
    })
  }, [])
}
