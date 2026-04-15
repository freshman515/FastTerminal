import { create } from 'zustand'

interface LaunchesState {
  launches: unknown[]
  _loadFromConfig: (raw: unknown[]) => void
}

export const useLaunchesStore = create<LaunchesState>((set) => ({
  launches: [],
  _loadFromConfig: () => { set({ launches: [] }) },
}))
