import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TerminalDataEvent, TerminalExitEvent, TerminalInfo, TerminalSnapshot } from './types'

/**
 * PTY daemon wire contract (docs/plans/pty-daemon.md). The daemon owns every
 * PTY and outlives the IDE; the Electron main process is a client. Bump
 * DAEMON_VERSION on any breaking change here — the supervisor's hello
 * handshake compares it and replaces a stale daemon.
 *
 * Transport: newline-delimited JSON on a Unix socket, same framing as the
 * public API socket (src/main/socket.ts):
 *   → {"id": 1, "method": "terminal.create", "params": {...}}
 *   ← {"id": 1, "result": {...}} | {"id": 1, "error": {"message": "..."}}
 * Clients that send `subscribe` additionally receive pushed events:
 *   ← {"event": "data", "payload": {...}}
 */

export const DAEMON_VERSION = 1

export const PTYD_DIR = join(homedir(), '.airun9')
export const PTYD_SOCKET_PATH = join(PTYD_DIR, 'ptyd.sock')
export const PTYD_LOG_PATH = join(PTYD_DIR, 'pty-daemon.log')

/** Wire shape of terminal.create — env arrives fully computed by the caller
 * (PATH prepend, API socket, zsh bootstrap); the daemon adds only the
 * per-terminal binding vars. Keeps the daemon dumb and restart-safe. */
export interface DaemonCreateParams {
  projectId: string
  cwd: string
  title?: string
  command?: string
  env?: Record<string, string>
  workerId?: string
}

export interface DaemonHello {
  version: number
  pid: number
}

export interface DaemonRequest {
  id: number
  method: string
  params?: unknown
}

export type DaemonResponse =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }

export interface DaemonEventFrame {
  event: 'created' | 'data' | 'exit' | 'closed'
  payload: unknown
}

export type DaemonFrame = DaemonResponse | DaemonEventFrame

/** Method → result shapes (params documented inline where non-obvious) */
export interface DaemonMethods {
  hello: DaemonHello
  subscribe: null
  'terminal.create': TerminalInfo
  'terminal.list': TerminalInfo[]
  'terminal.get': TerminalInfo
  'terminal.snapshot': TerminalSnapshot
  'terminal.read': { data: string; seq: number }
  'terminal.write': null
  'terminal.resize': null
  'terminal.close': null
  'terminal.kill': null
  /** killSessions: false leaves PTYs to die with the daemon anyway — it
   * exists so a future handoff can exit without touching them */
  shutdown: null
}

export type { TerminalDataEvent, TerminalExitEvent, TerminalInfo, TerminalSnapshot }
