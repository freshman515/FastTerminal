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

export const useWorktreesStore = create<WorktreesState>((set, get) => ({
  worktrees: [],
  selectedWorktreeId: null,
  _loaded: true,
  _loadFromConfig: () => { set({ _loaded: true }) },
  selectWorktree: (id) => set({ selectedWorktreeId: id }),
  getMainWorktree: (projectId) => get().worktrees.find((w) => w.projectId === projectId && w.isMain),
}))
