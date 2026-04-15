export function switchProjectContext(_projectId: string, _sessionId: string | null, _worktreeId: string | null): void {
  // no-op in FastTerminal (no project concept)
}

export function getDefaultWorktreeIdForProject(_projectId: string): string | undefined {
  return undefined
}
