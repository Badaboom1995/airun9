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
  status: TerminalStatus
  exitCode: number | null
  createdAt: number
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

/** Renderer push channels (webContents.send) */
export const EVENT_CHANNELS = [
  'terminal:created',
  'terminal:data',
  'terminal:exit',
  'terminal:closed',
  'worker:created',
  'worker:updated'
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
