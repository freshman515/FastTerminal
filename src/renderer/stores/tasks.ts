import { create } from 'zustand'

interface TasksState {
  activeTasks: unknown[]
  _loadFromConfig: (raw: unknown) => void
}

export const useTasksStore = create<TasksState>((set) => ({
  activeTasks: [],
  _loadFromConfig: () => { set({ activeTasks: [] }) },
}))
