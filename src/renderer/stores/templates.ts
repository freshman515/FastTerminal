import { create } from 'zustand'

interface TemplatesState {
  templates: unknown[]
  _loadFromConfig: (raw: unknown[]) => void
}

export const useTemplatesStore = create<TemplatesState>((set) => ({
  templates: [],
  _loadFromConfig: () => { set({ templates: [] }) },
}))
