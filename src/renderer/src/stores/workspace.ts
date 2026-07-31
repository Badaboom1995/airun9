import { create } from 'zustand'
import type {
  BlockInfo,
  BrowserInfo,
  LayoutNode,
  ProjectInfo,
  ProjectsState,
  TerminalInfo,
  WorkerInfo,
  WorkerRequest,
  WorktreeRequest
} from '../../../shared/types'

interface WorkspaceState {
  /** all open projects + which one the user is looking at */
  projects: ProjectInfo[]
  activeProjectId: string | null
  /** ALL projects' sessions (badges need them); views filter by project */
  terminals: TerminalInfo[]
  /** embedded browser pages, for tab decoration and the browser block UI */
  browsers: BrowserInfo[]
  /** keyed by terminalId for tab decoration */
  workers: Record<string, WorkerInfo>
  /** pending full-worker approvals across all projects */
  workerRequests: WorkerRequest[]
  /** pending worktree create/remove approvals across all projects */
  worktreeRequests: WorktreeRequest[]
  /** the ACTIVE project's layout tree; background trees live in main */
  layout: LayoutNode | null
  blocks: BlockInfo[]
  activeTerminalId: string | null
  setLayout: (layout: LayoutNode) => void
  setBlocks: (blocks: BlockInfo[]) => void

  setProjects: (state: ProjectsState) => void
  setTerminals: (terminals: TerminalInfo[]) => void
  upsertTerminal: (info: TerminalInfo) => void
  removeTerminal: (id: string) => void
  markTerminalExited: (id: string, exitCode: number) => void
  setActiveTerminal: (id: string | null) => void
  setWorkers: (workers: WorkerInfo[]) => void
  upsertWorker: (worker: WorkerInfo) => void
  setWorkerRequests: (requests: WorkerRequest[]) => void
  upsertWorkerRequest: (request: WorkerRequest) => void
  removeWorkerRequest: (requestId: string) => void
  setWorktreeRequests: (requests: WorktreeRequest[]) => void
  upsertWorktreeRequest: (request: WorktreeRequest) => void
  removeWorktreeRequest: (requestId: string) => void
  setBrowsers: (browsers: BrowserInfo[]) => void
  upsertBrowser: (info: BrowserInfo) => void
  removeBrowser: (id: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  projects: [],
  activeProjectId: null,
  terminals: [],
  browsers: [],
  workers: {},
  workerRequests: [],
  worktreeRequests: [],
  layout: null,
  blocks: [],
  activeTerminalId: null,
  setLayout: (layout) => set({ layout }),
  setBlocks: (blocks) => set({ blocks }),

  setProjects: ({ projects, activeId }) =>
    set((state) => ({
      projects,
      activeProjectId: activeId,
      // switching projects invalidates the previous tree until the fresh
      // one arrives — render nothing stale in between
      layout: activeId === state.activeProjectId ? state.layout : null
    })),

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
    set((state) => ({ workers: { ...state.workers, [worker.terminalId]: worker } })),

  setWorkerRequests: (workerRequests) => set({ workerRequests }),

  upsertWorkerRequest: (request) =>
    set((state) => ({
      workerRequests: state.workerRequests.some((r) => r.id === request.id)
        ? state.workerRequests
        : [...state.workerRequests, request]
    })),

  removeWorkerRequest: (requestId) =>
    set((state) => ({
      workerRequests: state.workerRequests.filter((r) => r.id !== requestId)
    })),

  setWorktreeRequests: (worktreeRequests) => set({ worktreeRequests }),

  upsertWorktreeRequest: (request) =>
    set((state) => ({
      worktreeRequests: state.worktreeRequests.some((r) => r.id === request.id)
        ? state.worktreeRequests
        : [...state.worktreeRequests, request]
    })),

  removeWorktreeRequest: (requestId) =>
    set((state) => ({
      worktreeRequests: state.worktreeRequests.filter((r) => r.id !== requestId)
    })),

  setBrowsers: (browsers) => set({ browsers }),

  upsertBrowser: (info) =>
    set((state) => ({
      browsers: state.browsers.some((b) => b.id === info.id)
        ? state.browsers.map((b) => (b.id === info.id ? info : b))
        : [...state.browsers, info]
    })),

  removeBrowser: (id) => set((state) => ({ browsers: state.browsers.filter((b) => b.id !== id) }))
}))
