import { Circle, Keyboard, Square, TextCursorInput } from 'lucide-react'
import { useOrchestratorStore, type AgentTimelineEventType } from '@/stores/orchestrator'
import { cn } from '@/lib/utils'

interface SessionTimelineProps {
  sessionId: string
  limit?: number
}

const EVENT_LABELS: Record<AgentTimelineEventType, string> = {
  start: 'Start',
  input: 'Input',
  output: 'Output',
  idle: 'Idle',
  summary: 'Summary',
  stop: 'Stop',
  error: 'Error',
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function addTimelineEvent(
  sessionId: string,
  event: AgentTimelineEventType | unknown,
  message?: string,
): void {
  const type: AgentTimelineEventType =
    event === 'start'
    || event === 'input'
    || event === 'output'
    || event === 'idle'
    || event === 'summary'
    || event === 'stop'
    || event === 'error'
      ? event
      : 'output'
  useOrchestratorStore.getState().addTimelineEvent(sessionId, type, message ?? EVENT_LABELS[type])
}

export function SessionTimeline({ sessionId, limit = 8 }: SessionTimelineProps): JSX.Element {
  const events = useOrchestratorStore((state) =>
    state.timeline.filter((event) => event.sessionId === sessionId).slice(0, limit),
  )

  if (events.length === 0) {
    return (
      <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
        No timeline events yet.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <div key={event.id} className="flex gap-2 text-[11px]">
          <div
            className={cn(
              'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border',
              event.type === 'error'
                ? 'border-[var(--color-error)]/40 text-[var(--color-error)]'
                : event.type === 'summary'
                  ? 'border-[var(--color-info)]/40 text-[var(--color-info)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-tertiary)]',
            )}
          >
            {event.type === 'input'
              ? <Keyboard size={11} />
              : event.type === 'summary'
                ? <TextCursorInput size={11} />
                : event.type === 'stop'
                  ? <Square size={9} />
                  : <Circle size={9} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-[var(--color-text-secondary)]">{EVENT_LABELS[event.type]}</span>
              <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">{formatTime(event.createdAt)}</span>
            </div>
            <div className="truncate text-[var(--color-text-tertiary)]" title={event.message}>
              {event.message}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
