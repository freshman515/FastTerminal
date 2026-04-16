import { create } from 'zustand'
import type { SessionStatus, SessionType } from '@shared/types'
import { generateId } from '@/lib/utils'

export type AgentRunStatus = 'running' | 'completed' | 'failed'
export type AgentWorkerStatus = 'queued' | 'starting' | 'running' | 'idle' | 'stopped' | 'failed'
export type AgentTimelineEventType = 'start' | 'input' | 'output' | 'idle' | 'summary' | 'stop' | 'error'

export interface AgentRun {
  id: string
  objective: string
  templateId: string
  templateName: string
  status: AgentRunStatus
  workerIds: string[]
  summary: string | null
  createdAt: number
  updatedAt: number
}

export interface AgentWorker {
  id: string
  runId: string
  roleId: string
  roleName: string
  roleColor: string
  instructions: string
  sessionId: string | null
  sessionType: SessionType
  sessionName: string
  status: AgentWorkerStatus
  cwd: string | null
  branch: string | null
  worktreeFallback: boolean
  outputBytes: number
  inputCount: number
  lastLine: string | null
  summary: string | null
  summarySourceLength: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  lastActivityAt: number | null
  finishedAt: number | null
}

export interface AgentTimelineEvent {
  id: string
  sessionId: string
  workerId: string | null
  type: AgentTimelineEventType
  message: string
  createdAt: number
}

interface CreateRunInput {
  objective: string
  templateId: string
  templateName: string
}

interface CreateWorkerInput {
  runId: string
  roleId: string
  roleName: string
  roleColor: string
  instructions: string
  sessionType: SessionType
  sessionName: string
}

interface AttachWorkerInput {
  sessionId: string
  cwd: string | null
  branch: string | null
  worktreeFallback: boolean
}

interface OrchestratorState {
  panelOpen: boolean
  activeRunId: string | null
  runs: AgentRun[]
  workers: Record<string, AgentWorker>
  sessionToWorker: Record<string, string>
  outputTails: Record<string, string>
  timeline: AgentTimelineEvent[]

  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  createRun: (input: CreateRunInput) => string
  createWorker: (input: CreateWorkerInput) => string
  attachWorkerSession: (workerId: string, input: AttachWorkerInput) => void
  updateWorker: (workerId: string, updates: Partial<Omit<AgentWorker, 'id'>>) => void
  updateWorkerBySession: (sessionId: string, updates: Partial<Omit<AgentWorker, 'id'>>) => void
  syncSessionStatus: (sessionId: string, status: SessionStatus) => void
  recordInput: (sessionId: string, message?: string) => void
  recordOutput: (sessionId: string, data: string) => void
  addTimelineEvent: (sessionId: string, type: AgentTimelineEventType, message: string) => void
  summarizeSession: (sessionId: string) => void
}

const MAX_TAIL_CHARS = 24_000
const MAX_TIMELINE_EVENTS = 800

function now(): number {
  return Date.now()
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[\?!]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][0-9A-B]|\x1b[>=<]|\x1b[a-zA-Z]/g, '')
    .replace(/\x1b/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

function compactWhitespace(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function tailText(existing: string, incoming: string): string {
  const combined = `${existing}${incoming}`
  return combined.length > MAX_TAIL_CHARS
    ? combined.slice(combined.length - MAX_TAIL_CHARS)
    : combined
}

function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(compactWhitespace)
    .filter((line) => line.length > 0)
}

function extractResultBlock(lines: string[]): string | null {
  const idx = lines.findLastIndex((line) => /^RESULT:/i.test(line))
  if (idx === -1) return null
  return lines.slice(idx, idx + 12).join('\n')
}

function pickSignals(lines: string[]): string[] {
  const signalPattern = /\b(result|summary|done|pass|passed|success|fail|failed|error|exception|modified|changed|files?|tests?|risk|block|blocked|验证|失败|通过|修改|风险|阻塞)\b/i
  const picked: string[] = []
  for (let i = lines.length - 1; i >= 0 && picked.length < 5; i -= 1) {
    const line = lines[i]
    if (line.length > 220) continue
    if (signalPattern.test(line)) picked.push(line)
  }
  return picked.reverse()
}

function summarizeTail(text: string): string {
  const lines = meaningfulLines(text)
  if (lines.length === 0) return 'No terminal output captured yet.'

  const resultBlock = extractResultBlock(lines)
  if (resultBlock) return resultBlock

  const lastLine = lines[lines.length - 1]
  const signals = pickSignals(lines)
  const bullets = signals.length > 0 ? signals : [lastLine]
  return bullets.map((line) => `- ${line}`).join('\n')
}

function updateRunStatus(state: OrchestratorState, runId: string): AgentRun | null {
  const run = state.runs.find((item) => item.id === runId)
  if (!run) return null

  const workers = run.workerIds.map((id) => state.workers[id]).filter(Boolean)
  if (workers.length === 0) return run

  const terminalStatuses = new Set<AgentWorkerStatus>(['idle', 'stopped', 'failed'])
  const complete = workers.every((worker) => terminalStatuses.has(worker.status))
  const failed = workers.some((worker) => worker.status === 'failed')
  const summaryParts = workers
    .filter((worker) => worker.summary)
    .map((worker) => `${worker.roleName}\n${worker.summary}`)
  const summary = complete && summaryParts.length > 0 ? summaryParts.join('\n\n') : run.summary

  return {
    ...run,
    status: complete ? (failed ? 'failed' : 'completed') : 'running',
    summary,
    updatedAt: now(),
  }
}

export const useOrchestratorStore = create<OrchestratorState>((set, get) => ({
  panelOpen: false,
  activeRunId: null,
  runs: [],
  workers: {},
  sessionToWorker: {},
  outputTails: {},
  timeline: [],

  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  createRun: (input) => {
    const id = generateId()
    const createdAt = now()
    const run: AgentRun = {
      id,
      objective: input.objective,
      templateId: input.templateId,
      templateName: input.templateName,
      status: 'running',
      workerIds: [],
      summary: null,
      createdAt,
      updatedAt: createdAt,
    }
    set((state) => ({
      panelOpen: true,
      activeRunId: id,
      runs: [run, ...state.runs].slice(0, 20),
    }))
    return id
  },

  createWorker: (input) => {
    const id = generateId()
    const createdAt = now()
    const worker: AgentWorker = {
      id,
      runId: input.runId,
      roleId: input.roleId,
      roleName: input.roleName,
      roleColor: input.roleColor,
      instructions: input.instructions,
      sessionId: null,
      sessionType: input.sessionType,
      sessionName: input.sessionName,
      status: 'queued',
      cwd: null,
      branch: null,
      worktreeFallback: false,
      outputBytes: 0,
      inputCount: 0,
      lastLine: null,
      summary: null,
      summarySourceLength: 0,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      lastActivityAt: null,
      finishedAt: null,
    }

    set((state) => ({
      workers: { ...state.workers, [id]: worker },
      runs: state.runs.map((run) =>
        run.id === input.runId
          ? { ...run, workerIds: [...run.workerIds, id], updatedAt: createdAt }
          : run,
      ),
    }))
    return id
  },

  attachWorkerSession: (workerId, input) =>
    set((state) => {
      const worker = state.workers[workerId]
      if (!worker) return state
      const updated: AgentWorker = {
        ...worker,
        ...input,
        status: 'starting',
        updatedAt: now(),
      }
      return {
        workers: { ...state.workers, [workerId]: updated },
        sessionToWorker: { ...state.sessionToWorker, [input.sessionId]: workerId },
      }
    }),

  updateWorker: (workerId, updates) =>
    set((state) => {
      const worker = state.workers[workerId]
      if (!worker) return state
      const updated = { ...worker, ...updates, updatedAt: now() }
      const nextState = {
        ...state,
        workers: { ...state.workers, [workerId]: updated },
      }
      const run = updateRunStatus(nextState, updated.runId)
      return {
        workers: nextState.workers,
        runs: run ? state.runs.map((item) => (item.id === run.id ? run : item)) : state.runs,
      }
    }),

  updateWorkerBySession: (sessionId, updates) => {
    const workerId = get().sessionToWorker[sessionId]
    if (!workerId) return
    get().updateWorker(workerId, updates)
  },

  syncSessionStatus: (sessionId, status) => {
    const workerId = get().sessionToWorker[sessionId]
    if (!workerId) return
    const worker = get().workers[workerId]
    if (!worker) return
    const mapped: AgentWorkerStatus =
      status === 'running'
        ? 'running'
        : status === 'idle'
          ? 'idle'
          : status === 'stopped'
            ? 'stopped'
            : 'running'
    get().updateWorker(workerId, {
      status: mapped,
      startedAt: worker.startedAt ?? (mapped === 'running' ? now() : null),
      finishedAt: mapped === 'idle' || mapped === 'stopped' ? now() : worker.finishedAt,
    })
    if (mapped === 'idle' || mapped === 'stopped') {
      get().summarizeSession(sessionId)
    }
  },

  recordInput: (sessionId, message = 'User input') => {
    const workerId = get().sessionToWorker[sessionId]
    if (!workerId) return
    const worker = get().workers[workerId]
    if (!worker) return
    const at = now()
    get().updateWorker(workerId, {
      inputCount: worker.inputCount + 1,
      lastActivityAt: at,
      startedAt: worker.startedAt ?? at,
    })
    get().addTimelineEvent(sessionId, 'input', message)
  },

  recordOutput: (sessionId, data) =>
    set((state) => {
      const workerId = state.sessionToWorker[sessionId]
      if (!workerId) return state
      const worker = state.workers[workerId]
      if (!worker) return state

      const cleaned = stripAnsi(data)
      const nextTail = tailText(state.outputTails[sessionId] ?? '', cleaned)
      const lines = meaningfulLines(cleaned)
      const lastLine = lines[lines.length - 1] ?? worker.lastLine
      const at = now()
      const updatedWorker: AgentWorker = {
        ...worker,
        status: worker.status === 'queued' || worker.status === 'starting' || worker.status === 'idle'
          ? 'running'
          : worker.status,
        outputBytes: worker.outputBytes + data.length,
        lastLine,
        startedAt: worker.startedAt ?? at,
        lastActivityAt: at,
        updatedAt: at,
      }

      return {
        workers: { ...state.workers, [workerId]: updatedWorker },
        outputTails: { ...state.outputTails, [sessionId]: nextTail },
      }
    }),

  addTimelineEvent: (sessionId, type, message) =>
    set((state) => {
      const workerId = state.sessionToWorker[sessionId] ?? null
      const event: AgentTimelineEvent = {
        id: generateId(),
        sessionId,
        workerId,
        type,
        message,
        createdAt: now(),
      }
      return {
        timeline: [event, ...state.timeline].slice(0, MAX_TIMELINE_EVENTS),
      }
    }),

  summarizeSession: (sessionId) => {
    const state = get()
    const workerId = state.sessionToWorker[sessionId]
    if (!workerId) return
    const worker = state.workers[workerId]
    const tail = state.outputTails[sessionId] ?? ''
    if (!worker || worker.summarySourceLength === tail.length) return
    const summary = summarizeTail(tail)
    get().updateWorker(workerId, {
      summary,
      summarySourceLength: tail.length,
    })
    get().addTimelineEvent(sessionId, 'summary', 'Summary refreshed')
  },
}))
