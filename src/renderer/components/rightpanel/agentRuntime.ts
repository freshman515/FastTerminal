import type { SessionStatus } from '@shared/types'
import { useOrchestratorStore } from '@/stores/orchestrator'

export function updateAgentStatus(sessionId: string, status: SessionStatus): void {
  useOrchestratorStore.getState().syncSessionStatus(sessionId, status)
}

export function trackSessionInput(sessionId: string, data = 'User input'): void {
  useOrchestratorStore.getState().recordInput(sessionId, data)
}

export function trackSessionOutput(sessionId: string, data: string | number): void {
  useOrchestratorStore.getState().recordOutput(sessionId, String(data))
}
