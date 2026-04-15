import { create } from 'zustand'

interface GroupsState {
  groups: unknown[]
  _loadFromConfig: (raw: unknown) => void
}

export const useGroupsStore = create<GroupsState>((set) => ({
  groups: [],
  _loadFromConfig: () => { set({ groups: [] }) },
}))
