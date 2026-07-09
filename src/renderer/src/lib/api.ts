import type {
  BlockGrantRequest,
  BlockInfo,
  BlockManifest,
  LayoutNode,
  LayoutTabItem,
  ProjectInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalSnapshot,
  WorkerInfo,
  WorkerRequest,
  WorkerRequestDecision
} from '../../../shared/types'

async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const response = await window.api.rpc(method, params)
  if (response.error) throw new Error(response.error.message)
  return response.result as T
}

export const api = {
  openProject: (path: string) => rpc<ProjectInfo>('project.open', { path }),
  getProject: () => rpc<ProjectInfo | null>('project.get'),

  createTerminal: (options?: { cwd?: string; title?: string }) =>
    rpc<TerminalInfo>('terminal.create', options ?? {}),
  listTerminals: () => rpc<TerminalInfo[]>('terminal.list'),
  snapshotTerminal: (id: string) => rpc<TerminalSnapshot>('terminal.snapshot', { id }),
  writeTerminal: (id: string, data: string) => rpc<void>('terminal.write', { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    rpc<void>('terminal.resize', { id, cols, rows }),
  closeTerminal: (id: string) => rpc<void>('terminal.close', { id }),

  listWorkers: () => rpc<WorkerInfo[]>('worker.list'),
  stopWorker: (id: string) => rpc<WorkerInfo>('worker.stop', { id }),
  closeWorker: (id: string) => rpc<WorkerInfo>('worker.close', { id }),
  pendingWorkerRequests: () => rpc<WorkerRequest[]>('worker.pendingRequests'),
  resolveWorkerRequest: (decision: WorkerRequestDecision) =>
    rpc<void>('worker.resolveRequest', decision),

  getLayout: () => rpc<LayoutNode>('layout.get'),
  setLayoutActive: (tabsId: string, itemId: string) =>
    rpc<void>('layout.setActive', { tabsId, itemId }),
  setLayoutRatios: (splitId: string, ratios: number[]) =>
    rpc<void>('layout.setRatios', { splitId, ratios }),
  removeLayoutItem: (itemId: string) => rpc<void>('layout.removeItem', { itemId }),

  listBlocks: () => rpc<BlockInfo[]>('block.list'),
  blockBundle: (name: string) =>
    rpc<{ code: string; manifest: BlockManifest }>('block.bundle', { name }),
  blockGrant: (name: string) => rpc<{ granted: string[] }>('block.grant', { name }),
  openBlock: (name: string, position?: 'tab' | 'right' | 'down') =>
    rpc<LayoutTabItem>('block.open', { name, position }),
  pendingBlockGrants: () => rpc<BlockGrantRequest[]>('block.pendingGrants'),
  resolveBlockGrant: (requestId: string, approved: boolean) =>
    rpc<void>('block.resolveGrant', { requestId, approved })
}

/** Typed wrappers over the preload event bridge */
export const events = {
  onTerminalCreated: (cb: (info: TerminalInfo) => void) =>
    window.api.on('terminal:created', cb as (payload: unknown) => void),
  onTerminalData: (cb: (event: TerminalDataEvent) => void) =>
    window.api.on('terminal:data', cb as (payload: unknown) => void),
  onTerminalExit: (cb: (event: TerminalExitEvent) => void) =>
    window.api.on('terminal:exit', cb as (payload: unknown) => void),
  onTerminalClosed: (cb: (event: { id: string }) => void) =>
    window.api.on('terminal:closed', cb as (payload: unknown) => void),
  onWorkerCreated: (cb: (worker: WorkerInfo) => void) =>
    window.api.on('worker:created', cb as (payload: unknown) => void),
  onWorkerUpdated: (cb: (worker: WorkerInfo) => void) =>
    window.api.on('worker:updated', cb as (payload: unknown) => void),
  onWorkerRequest: (cb: (request: WorkerRequest) => void) =>
    window.api.on('worker:request', cb as (payload: unknown) => void),
  onWorkerRequestResolved: (cb: (event: { requestId: string; approved: boolean }) => void) =>
    window.api.on('worker:request-resolved', cb as (payload: unknown) => void),
  onLayoutChanged: (cb: (layout: LayoutNode) => void) =>
    window.api.on('layout:changed', cb as (payload: unknown) => void),
  onBlocksChanged: (cb: (blocks: BlockInfo[]) => void) =>
    window.api.on('blocks:changed', cb as (payload: unknown) => void),
  onBlockUpdated: (cb: (event: { name: string }) => void) =>
    window.api.on('block:updated', cb as (payload: unknown) => void),
  onBlockGrantRequest: (cb: (request: BlockGrantRequest) => void) =>
    window.api.on('block:grant-request', cb as (payload: unknown) => void),
  onBlockGrantResolved: (cb: (event: { requestId: string; approved: boolean }) => void) =>
    window.api.on('block:grant-resolved', cb as (payload: unknown) => void)
}
