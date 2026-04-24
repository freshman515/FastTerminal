import { Bot, ChevronRight, GitBranch, Loader2, Play, RefreshCw, Target, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ANONYMOUS_PROJECT_ID, type SessionType } from '@shared/types'
import { cn } from '@/lib/utils'
import { useOrchestratorStore, type AgentRun, type AgentWorker } from '@/stores/orchestrator'
import { usePanesStore } from '@/stores/panes'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { useUIStore } from '@/stores/ui'
import { SessionTimeline } from './SessionTimeline'

interface RoleTemplate {
  id: string
  name: string
  shortName: string
  color: string
  readOnly?: boolean
  instructions: string
}

interface RunTemplate {
  id: string
  name: string
  description: string
  roles: RoleTemplate[]
}

const SESSION_TYPE: SessionType = 'codex-yolo'

const RUN_TEMPLATES: RunTemplate[] = [
  {
    id: 'feature-sprint',
    name: 'Feature Sprint',
    description: 'Builder, verifier, reviewer in isolated sessions.',
    roles: [
      {
        id: 'builder',
        name: 'Builder',
        shortName: 'Build',
        color: '#5fa0f5',
        instructions: 'Implement the requested feature with the smallest coherent patch. Keep changes scoped and run the most relevant verification.',
      },
      {
        id: 'verifier',
        name: 'Verifier',
        shortName: 'Verify',
        color: '#3ecf7b',
        instructions: 'Focus on tests, build verification, regressions, and missing edge cases. Add or adjust tests only when the signal is clear.',
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        shortName: 'Review',
        color: '#f0a23b',
        readOnly: true,
        instructions: 'Review the codebase and the target change. Do not edit files. Return bugs, risks, missing tests, and integration concerns.',
      },
    ],
  },
  {
    id: 'bug-hunt',
    name: 'Bug Hunt',
    description: 'Investigation, fix, and regression check.',
    roles: [
      {
        id: 'investigator',
        name: 'Investigator',
        shortName: 'Find',
        color: '#f0a23b',
        readOnly: true,
        instructions: 'Reproduce and isolate the bug. Do not edit files. Identify likely files, failure path, and a concrete fix plan.',
      },
      {
        id: 'fixer',
        name: 'Fixer',
        shortName: 'Fix',
        color: '#5fa0f5',
        instructions: 'Apply a targeted fix for the bug. Avoid broad refactors and preserve unrelated user or worker changes.',
      },
      {
        id: 'regression',
        name: 'Regression Check',
        shortName: 'Test',
        color: '#3ecf7b',
        instructions: 'Run focused verification and add regression coverage where practical. Report exact commands and outcomes.',
      },
    ],
  },
  {
    id: 'review-pass',
    name: 'Review Pass',
    description: 'Independent review plus verification signal.',
    roles: [
      {
        id: 'reviewer',
        name: 'Reviewer',
        shortName: 'Review',
        color: '#f0a23b',
        readOnly: true,
        instructions: 'Review current changes for bugs, behavioral regressions, missing tests, and risky assumptions. Do not edit files.',
      },
      {
        id: 'verifier',
        name: 'Verifier',
        shortName: 'Verify',
        color: '#3ecf7b',
        readOnly: true,
        instructions: 'Run or identify the most relevant verification commands. Do not edit files unless a trivial test command config issue blocks verification.',
      },
    ],
  },
]

function formatElapsed(start: number | null, end?: number | null): string {
  if (!start) return 'not started'
  const seconds = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function statusClass(status: AgentWorker['status']): string {
  if (status === 'failed') return 'border-[var(--color-error)]/40 text-[var(--color-error)]'
  if (status === 'stopped') return 'border-[var(--color-text-tertiary)]/40 text-[var(--color-text-tertiary)]'
  if (status === 'idle') return 'border-[var(--color-success)]/40 text-[var(--color-success)]'
  if (status === 'running') return 'border-[var(--color-info)]/40 text-[var(--color-info)]'
  return 'border-[var(--color-warning)]/40 text-[var(--color-warning)]'
}

function focusSession(sessionId: string): void {
  const paneStore = usePanesStore.getState()
  const paneId = Object.entries(paneStore.paneSessions)
    .find(([, ids]) => ids.includes(sessionId))?.[0]
  if (paneId) {
    paneStore.setActivePaneId(paneId)
    paneStore.setPaneActiveSession(paneId, sessionId)
  }
  useSessionsStore.getState().setActive(sessionId)
  useSessionsStore.getState().markAsRead(sessionId)
}

function buildPrompt(objective: string, role: RoleTemplate, cwd: string): string {
  const mode = role.readOnly
    ? '这是只读调查/复核任务。不要编辑任何文件。'
    : '可以编辑文件，但只做完成目标所需的最小改动。'

  return `你是 FastTerminal 多 Agent 编排中的 ${role.name} worker。你不是代码库里唯一的会话。
不要回滚用户改动，也不要回滚其他 worker 的改动；如果遇到冲突，先报告。

目标：
${objective}

你的职责：
${role.instructions}

工作目录：
${cwd}

约束：
- ${mode}
- 遵循代码库现有架构和风格。
- 不要粘贴完整文件或大段日志。
- 运行你能运行的最相关验证；如果不能运行，说明原因。
- 最终必须用 RESULT 格式汇报。

RESULT:
- 状态：
- 修改文件：
- 验证：
- 风险：
- 阻塞：
- 建议下一步：`
}

function waitForPty(sessionId: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const current = useSessionsStore.getState().sessions.find((session) => session.id === sessionId)
    if (current?.ptyId) {
      resolve(current.ptyId)
      return
    }

    let unsubscribe = (): void => {}
    const timer = window.setTimeout(() => {
      unsubscribe()
      reject(new Error(`Session ${sessionId} did not start within ${timeoutMs}ms.`))
    }, timeoutMs)

    unsubscribe = useSessionsStore.subscribe((state) => {
      const session = state.sessions.find((item) => item.id === sessionId)
      if (!session?.ptyId) return
      window.clearTimeout(timer)
      unsubscribe()
      resolve(session.ptyId)
    })
  })
}

function RunSummary({ run }: { run: AgentRun }): JSX.Element {
  if (!run.summary) {
    return (
      <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
        Summary appears automatically when workers go idle or stop.
      </div>
    )
  }

  return (
    <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
      {run.summary}
    </pre>
  )
}

function WorkerCard({ worker }: { worker: AgentWorker }): JSX.Element {
  const summarizeSession = useOrchestratorStore((state) => state.summarizeSession)
  const sessionExists = useSessionsStore((state) =>
    worker.sessionId ? state.sessions.some((session) => session.id === worker.sessionId) : false,
  )

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: worker.roleColor }} />
            <div className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
              {worker.roleName}
            </div>
          </div>
          <div className="mt-1 truncate text-[11px] text-[var(--color-text-tertiary)]" title={worker.cwd ?? ''}>
            {worker.cwd ?? 'cwd pending'}
          </div>
        </div>
        <span className={cn('shrink-0 rounded-[var(--radius-sm)] border px-2 py-0.5 text-[10px] uppercase', statusClass(worker.status))}>
          {worker.status}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-[var(--color-text-tertiary)]">
        <div>
          <div className="text-[10px] uppercase">Runtime</div>
          <div className="text-[var(--color-text-secondary)]">{formatElapsed(worker.startedAt, worker.finishedAt)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase">Output</div>
          <div className="text-[var(--color-text-secondary)]">{formatBytes(worker.outputBytes)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase">Inputs</div>
          <div className="text-[var(--color-text-secondary)]">{worker.inputCount}</div>
        </div>
      </div>

      {worker.branch && (
        <div className="mt-2 flex items-center gap-1.5 truncate text-[11px] text-[var(--color-text-tertiary)]" title={worker.branch}>
          <GitBranch size={12} />
          <span className="truncate">{worker.branch}</span>
          {worker.worktreeFallback && <span className="text-[var(--color-warning)]">fallback</span>}
        </div>
      )}

      {worker.lastLine && (
        <div className="mt-2 truncate rounded-[var(--radius-sm)] bg-[var(--color-bg-primary)] px-2 py-1.5 text-[11px] text-[var(--color-text-tertiary)]" title={worker.lastLine}>
          {worker.lastLine}
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">Auto Summary</span>
          {worker.sessionId && (
            <button
              type="button"
              onClick={() => summarizeSession(worker.sessionId!)}
              className="rounded-[var(--radius-sm)] p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
              title="Refresh summary"
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
        {worker.summary ? (
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
            {worker.summary}
          </pre>
        ) : (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
            Waiting for idle output.
          </div>
        )}
      </div>

      {worker.sessionId && (
        <div className="mt-3">
          <SessionTimeline sessionId={worker.sessionId} />
        </div>
      )}

      {worker.sessionId && sessionExists && (
        <button
          type="button"
          onClick={() => focusSession(worker.sessionId!)}
          className="mt-3 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-border-hover)] hover:bg-[var(--color-bg-tertiary)]"
        >
          Focus session
        </button>
      )}
    </div>
  )
}

export function AgentOrchestratorPanel(): JSX.Element {
  const panelOpen = useOrchestratorStore((state) => state.panelOpen)
  const closePanel = useOrchestratorStore((state) => state.closePanel)
  const createRun = useOrchestratorStore((state) => state.createRun)
  const createWorker = useOrchestratorStore((state) => state.createWorker)
  const attachWorkerSession = useOrchestratorStore((state) => state.attachWorkerSession)
  const updateWorker = useOrchestratorStore((state) => state.updateWorker)
  const runs = useOrchestratorStore((state) => state.runs)
  const workers = useOrchestratorStore((state) => state.workers)
  const activeRunId = useOrchestratorStore((state) => state.activeRunId)
  const syncSessionStatus = useOrchestratorStore((state) => state.syncSessionStatus)
  const addToast = useUIStore((state) => state.addToast)

  const sessions = useSessionsStore((state) => state.sessions)
  const activePaneId = usePanesStore((state) => state.activePaneId)
  const activeSessionId = usePanesStore((state) => state.paneActiveSession[activePaneId] ?? null)
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId)
  const selectedProject = useProjectsStore((state) =>
    state.projects.find((project) => project.id === state.selectedProjectId),
  )
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null

  const [objective, setObjective] = useState('')
  const [launching, setLaunching] = useState(false)

  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null
  const runWorkers = useMemo(() => {
    if (!activeRun) return []
    return activeRun.workerIds.map((id) => workers[id]).filter(Boolean)
  }, [activeRun, workers])

  useEffect(() => {
    const state = useOrchestratorStore.getState()
    for (const session of sessions) {
      if (state.sessionToWorker[session.id]) {
        syncSessionStatus(session.id, session.status)
      }
    }
  }, [sessions, syncSessionStatus])

  const startRun = useCallback(async (template: RunTemplate) => {
    const goal = objective.trim()
    if (!goal) {
      addToast({
        type: 'warning',
        title: 'Missing objective',
        body: 'Describe the task before launching agents.',
      })
      return
    }

    setLaunching(true)
    const sessionStore = useSessionsStore.getState()
    const paneStore = usePanesStore.getState()
    const projectId = activeSession?.projectId ?? selectedProjectId ?? ANONYMOUS_PROJECT_ID
    let baseCwd = activeSession?.cwd ?? selectedProject?.path ?? ''
    if (!baseCwd) {
      baseCwd = await window.api.config.getAnonymousWorkspace()
    }

    const runId = createRun({
      objective: goal,
      templateId: template.id,
      templateName: template.name,
    })

    try {
      for (const role of template.roles) {
        const workerId = createWorker({
          runId,
          roleId: role.id,
          roleName: role.name,
          roleColor: role.color,
          instructions: role.instructions,
          sessionType: SESSION_TYPE,
          sessionName: `${role.shortName} · ${template.name}`,
        })
        updateWorker(workerId, { status: 'starting', cwd: baseCwd })

        const worktree = role.readOnly
          ? { path: baseCwd, branch: null, fallback: false }
          : await window.api.orchestration.createWorktree({
              cwd: baseCwd,
              runId,
              workerId,
              slug: role.id,
            })
        const cwd = worktree.path || baseCwd

        const sessionId = sessionStore.addSession(projectId, SESSION_TYPE)
        sessionStore.updateSession(sessionId, {
          name: `${role.shortName} · ${template.name}`,
          label: role.shortName,
          color: role.color,
          cwd,
        })
        attachWorkerSession(workerId, {
          sessionId,
          cwd,
          branch: worktree.branch,
          worktreeFallback: worktree.fallback,
        })

        paneStore.addSessionToPane(paneStore.activePaneId, sessionId)
        paneStore.setPaneActiveSession(paneStore.activePaneId, sessionId)
        sessionStore.setActive(sessionId)

        const ptyId = await waitForPty(sessionId, 10_000)
        const prompt = buildPrompt(goal, role, cwd)
        await window.api.session.write(ptyId, prompt)
        await new Promise((resolve) => window.setTimeout(resolve, 120))
        await window.api.session.write(ptyId, '\r')
      }
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Agent launch failed',
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setLaunching(false)
    }
  }, [activeSession?.cwd, activeSession?.projectId, addToast, attachWorkerSession, createRun, createWorker, objective, selectedProject?.path, selectedProjectId, updateWorker])

  if (!panelOpen) {
    return null
  }

  return (
    <aside className="relative z-30 flex h-full w-[380px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-xl shadow-black/25">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-bg-tertiary)] text-[var(--color-info)]">
            <Bot size={15} />
          </div>
          <div>
            <div className="text-[13px] font-semibold text-[var(--color-text-primary)]">Agent Orchestrator</div>
            <div className="text-[10px] text-[var(--color-text-tertiary)]">launch, monitor, summarize</div>
          </div>
        </div>
        <button
          type="button"
          onClick={closePanel}
          className="rounded-[var(--radius-sm)] p-1.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
          title="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
          <label className="flex items-center gap-2 text-[11px] font-medium uppercase text-[var(--color-text-tertiary)]">
            <Target size={12} />
            Objective
          </label>
          <textarea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="Describe the feature, bug, or review target..."
            className="mt-2 h-24 w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-hover)]"
          />
          <div className="mt-3 grid gap-2">
            {RUN_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => void startRun(template)}
                disabled={launching}
                className={cn(
                  'flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-left',
                  'text-[var(--color-text-secondary)] hover:border-[var(--color-border-hover)] hover:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-[var(--color-text-primary)]">{template.name}</span>
                  <span className="block truncate text-[11px] text-[var(--color-text-tertiary)]">{template.description}</span>
                </span>
                {launching ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap size={13} className="text-[var(--color-warning)]" />
              <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">Current Run</span>
            </div>
            {activeRun && (
              <span className="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-text-tertiary)]">
                {activeRun.status}
              </span>
            )}
          </div>

          {activeRun ? (
            <div>
              <div className="text-[13px] font-medium text-[var(--color-text-primary)]">{activeRun.templateName}</div>
              <div className="mt-1 line-clamp-3 text-[11px] text-[var(--color-text-tertiary)]">{activeRun.objective}</div>
              <div className="mt-3">
                <RunSummary run={activeRun} />
              </div>
            </div>
          ) : (
            <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-[11px] text-[var(--color-text-tertiary)]">
              No agent run yet.
            </div>
          )}
        </div>

        <div className="mt-3 space-y-3">
          {runWorkers.map((worker) => (
            <WorkerCard key={worker.id} worker={worker} />
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={closePanel}
        className="absolute -left-7 top-1/2 flex -translate-y-1/2 items-center justify-center rounded-l-[var(--radius-md)] border border-r-0 border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1.5 py-3 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]"
        title="Collapse agent panel"
      >
        <ChevronRight size={13} />
      </button>
    </aside>
  )
}
