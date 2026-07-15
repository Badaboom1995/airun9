import type {
  ArchitectureState,
  BlockGrantRequest,
  BlockInfo,
  BlockManifest,
  BrowserInfo,
  FileEntry,
  FileReadResult,
  LayoutChangedEvent,
  LayoutNode,
  LayoutTabItem,
  PanePosition,
  ProjectInfo,
  ProjectsState,
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
  listProjects: () => rpc<ProjectsState>('project.list'),
  activateProject: (id: string) => rpc<ProjectInfo>('project.activate', { id }),
  closeProject: (id: string) => rpc<void>('project.close', { id }),

  listFiles: (path = '.') => rpc<FileEntry[]>('fs.list', { path }),
  readFile: (path: string) => rpc<FileReadResult>('fs.read', { path }),

  createTerminal: (options?: { cwd?: string; title?: string }) =>
    rpc<TerminalInfo>('terminal.create', options ?? {}),
  // the renderer keeps every project's sessions in the store (badges,
  // background tab decoration), so it always asks for the full set
  listTerminals: () => rpc<TerminalInfo[]>('terminal.list', { all: true }),
  snapshotTerminal: (id: string) => rpc<TerminalSnapshot>('terminal.snapshot', { id }),
  writeTerminal: (id: string, data: string) => rpc<void>('terminal.write', { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    rpc<void>('terminal.resize', { id, cols, rows }),
  closeTerminal: (id: string) => rpc<void>('terminal.close', { id }),

  createBrowser: (options?: { url?: string; position?: PanePosition }) =>
    rpc<BrowserInfo>('browser.create', options ?? {}),
  listBrowsers: () => rpc<BrowserInfo[]>('browser.list', { all: true }),
  getBrowser: (id: string) => rpc<BrowserInfo>('browser.get', { id }),
  attachBrowser: (id: string, webContentsId: number) =>
    rpc<BrowserInfo>('browser.attach', { id, webContentsId }),
  navigateBrowser: (id: string, url: string) => rpc<BrowserInfo>('browser.navigate', { id, url }),
  browserBack: (id: string) => rpc<void>('browser.back', { id }),
  browserForward: (id: string) => rpc<void>('browser.forward', { id }),
  browserReload: (id: string) => rpc<void>('browser.reload', { id }),
  browserStop: (id: string) => rpc<void>('browser.stop', { id }),
  closeBrowser: (id: string) => rpc<void>('browser.close', { id }),

  listWorkers: () => rpc<WorkerInfo[]>('worker.list', { all: true }),
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
  openLayoutBeside: (
    refItemId: string,
    block: string,
    config: Record<string, unknown>,
    side: 'left' | 'right' = 'right'
  ) => rpc<LayoutTabItem>('layout.openBeside', { refItemId, block, config, side }),
  updateLayoutItem: (itemId: string, config: Record<string, unknown>) =>
    rpc<LayoutTabItem>('layout.updateItem', { itemId, config }),
  removeLayoutItem: (itemId: string) => rpc<void>('layout.removeItem', { itemId }),

  listBlocks: () => rpc<BlockInfo[]>('block.list'),
  blockBundle: (name: string) =>
    rpc<{ code: string; manifest: BlockManifest }>('block.bundle', { name }),
  blockGrant: (name: string) => rpc<{ granted: string[] }>('block.grant', { name }),
  openBlock: (name: string, position?: PanePosition) =>
    rpc<LayoutTabItem>('block.open', { name, position }),
  pendingBlockGrants: () => rpc<BlockGrantRequest[]>('block.pendingGrants'),
  resolveBlockGrant: (requestId: string, approved: boolean) =>
    rpc<void>('block.resolveGrant', { requestId, approved }),

  getArchitecture: () => rpc<ArchitectureState>('architecture.get')
}

/** Typed wrappers over the preload event bridge */
export const events = {
  onProjectChanged: (cb: (state: ProjectsState) => void) =>
    window.api.on('project:changed', cb as (payload: unknown) => void),
  onTerminalCreated: (cb: (info: TerminalInfo) => void) =>
    window.api.on('terminal:created', cb as (payload: unknown) => void),
  onTerminalData: (cb: (event: TerminalDataEvent) => void) =>
    window.api.on('terminal:data', cb as (payload: unknown) => void),
  onTerminalExit: (cb: (event: TerminalExitEvent) => void) =>
    window.api.on('terminal:exit', cb as (payload: unknown) => void),
  onTerminalClosed: (cb: (event: { id: string }) => void) =>
    window.api.on('terminal:closed', cb as (payload: unknown) => void),
  onBrowserCreated: (cb: (info: BrowserInfo) => void) =>
    window.api.on('browser:created', cb as (payload: unknown) => void),
  onBrowserUpdated: (cb: (info: BrowserInfo) => void) =>
    window.api.on('browser:updated', cb as (payload: unknown) => void),
  onBrowserClosed: (cb: (event: { id: string }) => void) =>
    window.api.on('browser:closed', cb as (payload: unknown) => void),
  onWorkerCreated: (cb: (worker: WorkerInfo) => void) =>
    window.api.on('worker:created', cb as (payload: unknown) => void),
  onWorkerUpdated: (cb: (worker: WorkerInfo) => void) =>
    window.api.on('worker:updated', cb as (payload: unknown) => void),
  onWorkerRequest: (cb: (request: WorkerRequest) => void) =>
    window.api.on('worker:request', cb as (payload: unknown) => void),
  onWorkerRequestResolved: (cb: (event: { requestId: string; approved: boolean }) => void) =>
    window.api.on('worker:request-resolved', cb as (payload: unknown) => void),
  onLayoutChanged: (cb: (event: LayoutChangedEvent) => void) =>
    window.api.on('layout:changed', cb as (payload: unknown) => void),
  onBlocksChanged: (cb: (blocks: BlockInfo[]) => void) =>
    window.api.on('blocks:changed', cb as (payload: unknown) => void),
  onBlockUpdated: (cb: (event: { name: string }) => void) =>
    window.api.on('block:updated', cb as (payload: unknown) => void),
  onBlockGrantRequest: (cb: (request: BlockGrantRequest) => void) =>
    window.api.on('block:grant-request', cb as (payload: unknown) => void),
  onBlockGrantResolved: (cb: (event: { requestId: string; approved: boolean }) => void) =>
    window.api.on('block:grant-resolved', cb as (payload: unknown) => void),
  onArchitectureChanged: (cb: (state: ArchitectureState) => void) =>
    window.api.on('architecture:changed', cb as (payload: unknown) => void)
}
