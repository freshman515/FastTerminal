import { create } from 'zustand'

interface GitState {
  branchInfo: Record<string, { current: string; branches: string[]; isDirty: boolean } | undefined>
}

export const useGitStore = create<GitState>(() => ({
  branchInfo: {},
}))
