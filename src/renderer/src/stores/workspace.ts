import { create } from 'zustand'
import type { ProjectInfo, TerminalInfo } from '../../../shared/types'

interface WorkspaceState {
  project: ProjectInfo | null
  terminals: TerminalInfo[]
  activeTerminalId: string | null

  setProject: (project: ProjectInfo | null) => void
  setTerminals: (terminals: TerminalInfo[]) => void
  upsertTerminal: (info: TerminalInfo) => void
  removeTerminal: (id: string) => void
  markTerminalExited: (id: string, exitCode: number) => void
  setActiveTerminal: (id: string | null) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  project: null,
  terminals: [],
  activeTerminalId: null,

  setProject: (project) => set({ project }),

  setTerminals: (terminals) =>
    set((state) => ({
      terminals,
      activeTerminalId:
        state.activeTerminalId && terminals.some((t) => t.id === state.activeTerminalId)
          ? state.activeTerminalId
          : (terminals[0]?.id ?? null)
    })),

  upsertTerminal: (info) =>
    set((state) => {
      const exists = state.terminals.some((t) => t.id === info.id)
      return {
        terminals: exists
          ? state.terminals.map((t) => (t.id === info.id ? info : t))
          : [...state.terminals, info],
        activeTerminalId: state.activeTerminalId ?? info.id
      }
    }),

  removeTerminal: (id) =>
    set((state) => {
      const terminals = state.terminals.filter((t) => t.id !== id)
      return {
        terminals,
        activeTerminalId:
          state.activeTerminalId === id
            ? (terminals[terminals.length - 1]?.id ?? null)
            : state.activeTerminalId
      }
    }),

  markTerminalExited: (id, exitCode) =>
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, status: 'exited' as const, exitCode } : t
      )
    })),

  setActiveTerminal: (id) => set({ activeTerminalId: id })
}))
