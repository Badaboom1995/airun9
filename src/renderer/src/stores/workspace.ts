import { create } from 'zustand'
import type {
  BlockInfo,
  LayoutNode,
  ProjectInfo,
  TerminalInfo,
  WorkerInfo
} from '../../../shared/types'

interface WorkspaceState {
  project: ProjectInfo | null
  terminals: TerminalInfo[]
  /** keyed by terminalId for tab decoration */
  workers: Record<string, WorkerInfo>
  /** mirror of main's layout tree; UI renders this, mutations go via API */
  layout: LayoutNode | null
  blocks: BlockInfo[]
  activeTerminalId: string | null
  setLayout: (layout: LayoutNode) => void
  setBlocks: (blocks: BlockInfo[]) => void

  setProject: (project: ProjectInfo | null) => void
  setTerminals: (terminals: TerminalInfo[]) => void
  upsertTerminal: (info: TerminalInfo) => void
  removeTerminal: (id: string) => void
  markTerminalExited: (id: string, exitCode: number) => void
  setActiveTerminal: (id: string | null) => void
  setWorkers: (workers: WorkerInfo[]) => void
  upsertWorker: (worker: WorkerInfo) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  project: null,
  terminals: [],
  workers: {},
  layout: null,
  blocks: [],
  activeTerminalId: null,
  setLayout: (layout) => set({ layout }),
  setBlocks: (blocks) => set({ blocks }),

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

  setActiveTerminal: (id) => set({ activeTerminalId: id }),

  setWorkers: (workers) =>
    set({ workers: Object.fromEntries(workers.map((w) => [w.terminalId, w])) }),

  upsertWorker: (worker) =>
    set((state) => ({ workers: { ...state.workers, [worker.terminalId]: worker } }))
}))
