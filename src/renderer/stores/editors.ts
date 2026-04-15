import { create } from 'zustand'

export interface EditorTab {
  id: string
  filePath: string
  fileName: string
  language: string
  projectId: string
  worktreeId?: string
  modified?: boolean
  isDiff?: boolean
  content?: string
}

export const FILE_ICONS: Record<string, { icon: string; color: string }> = {
  plaintext: { icon: 'T', color: '#808080' },
}

export function detectLanguage(_fileName: string): string {
  return 'plaintext'
}

export function sanitizeEditorTab(_tab: unknown, _ctx?: { projectId: string; worktreeId?: string }): EditorTab | null {
  return null
}

interface EditorsState {
  tabs: EditorTab[]
  _loadFromConfig: (raw: unknown[]) => void
  upsertTabs: (tabs: EditorTab[]) => void
  closeTab: (id: string) => void
  getTab: (id: string) => EditorTab | undefined
}

export const useEditorsStore = create<EditorsState>((set, get) => ({
  tabs: [],
  _loadFromConfig: () => { set({ tabs: [] }) },
  upsertTabs: () => {},
  closeTab: () => {},
  getTab: (id) => get().tabs.find((t) => t.id === id),
}))
