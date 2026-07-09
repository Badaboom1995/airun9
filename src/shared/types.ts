// Shared contracts between main, preload, renderer and the socket API.
// One dispatcher, many doors (ADR-0008): every door speaks these shapes.

export type TerminalStatus = 'running' | 'exited'

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  cols: number
  rows: number
  status: TerminalStatus
  exitCode: number | null
  /** Set when this terminal is owned by a Worker */
  workerId: string | null
  createdAt: number
}

export interface WorkerInfo {
  id: string
  name: string
  prompt: string
  terminalId: string
  kind: WorkerKind
  mode: WorkerMode
  location: WorkerLocation
  /** Directory the worker runs in (project dir or its worktree) */
  cwd: string
  /**
   * running — agent is working on a turn
   * done — agent finished its turn and is idle (keep-alive; can be prompted)
   * exited — process is gone (stopped or crashed)
   */
  status: WorkerStatus
  exitCode: number | null
  /** Claude Code transcript (JSONL), reported by the Stop hook */
  transcriptPath: string | null
  createdAt: number
}

export type WorkerKind = 'scout' | 'full'
/** plan = read-only research; manual = user answers permission prompts in the tab */
export type WorkerMode = 'plan' | 'bypass' | 'edits' | 'manual'
export type WorkerLocation = 'shared' | 'worktree'
export type WorkerStatus = 'running' | 'done' | 'exited'

/** A pending "spawn full worker" approval shown to the user in the app */
export interface WorkerRequest {
  id: string
  prompt: string
  name: string | null
  count: number
  reason: string | null
  recommendedMode: Exclude<WorkerMode, 'plan'>
  recommendedLocation: WorkerLocation
  createdAt: number
}

export interface WorkerRequestDecision {
  requestId: string
  approved: boolean
  mode: Exclude<WorkerMode, 'plan'>
  location: WorkerLocation
}

export interface ProjectInfo {
  path: string
  name: string
}

/**
 * Scrollback snapshot. `seq` is the cumulative count of characters the
 * terminal has ever emitted; data events carry the same counter so a client
 * can replay the snapshot and then apply only events with seq > snapshot.seq.
 */
export interface TerminalSnapshot {
  info: TerminalInfo
  data: string
  seq: number
}

export interface TerminalDataEvent {
  id: string
  data: string
  /** Cumulative char count after this chunk was appended */
  seq: number
}

export interface TerminalExitEvent {
  id: string
  exitCode: number
}

/**
 * Layout is pure serialized data (ADR-0001): a split tree whose leaves are
 * tab groups of block instances. Main owns it; renderer renders it; agents
 * edit it via layout.get/set.
 */
export interface LayoutTabItem {
  id: string
  /** block type in the registry: 'terminal', 'custom', ... */
  block: string
  config: Record<string, unknown>
}

export interface TabsNode {
  type: 'tabs'
  id: string
  active: string | null
  items: LayoutTabItem[]
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: 'row' | 'column'
  /** one entry per child, sums to ~1 */
  ratios: number[]
  children: LayoutNode[]
}

export type LayoutNode = TabsNode | SplitNode

/** Where block.open places a new pane */
export type PanePosition = 'tab' | 'right' | 'down'

/** Manifest of a user/agent-authored block (~/.airun9/blocks/<name>/block.json) */
export interface BlockManifest {
  name: string
  title?: string
  /** API methods the block may call; undeclared methods are always denied */
  capabilities: string[]
}

export interface BlockInfo {
  name: string
  manifest: BlockManifest
  /** compile error, if the last build failed */
  error: string | null
}

/** Pending "grant this block its capabilities" decision */
export interface BlockGrantRequest {
  id: string
  blockName: string
  title: string
  /** the mutating subset that needs explicit approval */
  capabilities: string[]
}

/** Renderer push channels (webContents.send) */
export const EVENT_CHANNELS = [
  'terminal:created',
  'terminal:data',
  'terminal:exit',
  'terminal:closed',
  'worker:created',
  'worker:updated',
  'worker:request',
  'worker:request-resolved',
  'layout:changed',
  'blocks:changed',
  'block:updated',
  'block:grant-request',
  'block:grant-resolved'
] as const

export type EventChannel = (typeof EVENT_CHANNELS)[number]

export interface RpcResponse {
  result?: unknown
  error?: { message: string }
}

/** The preload bridge exposed to the renderer as `window.api` */
export interface Airun9Bridge {
  rpc(method: string, params?: unknown): Promise<RpcResponse>
  pickDirectory(): Promise<string | null>
  /** Subscribe to a push channel; returns an unsubscribe function */
  on(channel: EventChannel, callback: (payload: unknown) => void): () => void
}
