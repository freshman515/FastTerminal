import { create } from 'zustand'

export interface Worktree {
  id: string
  projectId: string
  path: string
  branch: string
  isMain: boolean
}

interface WorktreesState {
  worktrees: Worktree[]
  selectedWorktreeId: string | null
  _loaded: boolean
  _loadFromConfig: (raw: unknown[]) => void
  selectWorktree: (id: string | null) => void
  getMainWorktree: (projectId: string) => Worktree | undefined
}

function sanitizeWorktree(worktree: unknown): Worktree | null {
  if (!worktree || typeof worktree !== 'object') return null
  const value = worktree as Record<string, unknown>
  if (
    typeof value.id !== 'string'
    || typeof value.projectId !== 'string'
    || typeof value.path !== 'string'
    || typeof value.branch !== 'string'
  ) {
    return null
  }

  return {
    id: value.id,
    projectId: value.projectId,
    path: value.path,
    branch: value.branch,
    isMain: value.isMain === true,
  }
}

export const useWorktreesStore = create<WorktreesState>((set, get) => ({
  worktrees: [],
  selectedWorktreeId: null,
  _loaded: true,
  _loadFromConfig: (raw) => {
    const worktrees = (Array.isArray(raw) ? raw : [])
      .map(sanitizeWorktree)
      .filter((worktree): worktree is Worktree => worktree !== null)
    set({ worktrees, _loaded: true })
  },
  selectWorktree: (id) => set({ selectedWorktreeId: id }),
  getMainWorktree: (projectId) => get().worktrees.find((w) => w.projectId === projectId && w.isMain),
}))
