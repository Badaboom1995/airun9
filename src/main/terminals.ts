import { EventEmitter } from 'node:events'
import { spawn, type IPty } from 'node-pty'
import { nanoid } from 'nanoid'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalSnapshot
} from '../shared/types'

/** Max scrollback kept per terminal for snapshots and API reads */
const SCROLLBACK_CHARS = 512 * 1024
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export interface CreateTerminalOptions {
  cwd: string
  title?: string
  /** Run this command via an interactive login shell instead of a plain shell */
  command?: string
  env?: Record<string, string>
  workerId?: string
}

interface ManagedTerminal {
  info: TerminalInfo
  pty: IPty | null
  buffer: string
  seq: number
}

/**
 * Owns every PTY in the app. Lives in the main process for now; the
 * interface (create/attach-by-snapshot/read/write) is shaped so it can move
 * behind a detached daemon later (ADR-0005: the daemon boundary is the
 * future network boundary).
 */
export class TerminalManager extends EventEmitter {
  private terminals = new Map<string, ManagedTerminal>()

  constructor(private baseEnv: () => Record<string, string>) {
    super()
  }

  create(options: CreateTerminalOptions): TerminalInfo {
    const id = `term_${nanoid(10)}`
    const shell = process.env.SHELL || '/bin/zsh'
    // -i so rc files run and tools like claude resolve from the user's PATH
    const args = options.command ? ['-ilc', options.command] : ['-il']

    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: options.cwd,
      env: {
        ...process.env,
        ...this.baseEnv(),
        ...options.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      } as Record<string, string>
    })

    const info: TerminalInfo = {
      id,
      title: options.title ?? `Terminal ${this.terminals.size + 1}`,
      cwd: options.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      status: 'running',
      exitCode: null,
      workerId: options.workerId ?? null,
      createdAt: Date.now()
    }

    const managed: ManagedTerminal = { info, pty, buffer: '', seq: 0 }
    this.terminals.set(id, managed)

    pty.onData((data) => {
      managed.seq += data.length
      managed.buffer = (managed.buffer + data).slice(-SCROLLBACK_CHARS)
      const event: TerminalDataEvent = { id, data, seq: managed.seq }
      this.emit('data', event)
    })

    pty.onExit(({ exitCode }) => {
      managed.info.status = 'exited'
      managed.info.exitCode = exitCode
      managed.pty = null
      const event: TerminalExitEvent = { id, exitCode }
      this.emit('exit', event)
    })

    this.emit('created', info)
    return info
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => t.info)
  }

  get(id: string): TerminalInfo {
    return this.managed(id).info
  }

  snapshot(id: string): TerminalSnapshot {
    const t = this.managed(id)
    return { info: t.info, data: t.buffer, seq: t.seq }
  }

  /** Tail of the scrollback, for API consumers (agents reading output) */
  read(id: string, tailChars = 20_000): { data: string; seq: number } {
    const t = this.managed(id)
    return { data: t.buffer.slice(-tailChars), seq: t.seq }
  }

  write(id: string, data: string): void {
    const t = this.managed(id)
    t.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.managed(id)
    if (cols > 0 && rows > 0) {
      t.info.cols = cols
      t.info.rows = rows
      t.pty?.resize(cols, rows)
    }
  }

  /** Kill the process (if running) and drop the terminal entirely */
  close(id: string): void {
    const t = this.managed(id)
    t.pty?.kill()
    this.terminals.delete(id)
    this.emit('closed', { id })
  }

  /** Kill the process but keep the terminal (worker stop) */
  kill(id: string): void {
    this.managed(id).pty?.kill()
  }

  disposeAll(): void {
    for (const t of this.terminals.values()) t.pty?.kill()
    this.terminals.clear()
  }

  private managed(id: string): ManagedTerminal {
    const t = this.terminals.get(id)
    if (!t) throw new Error(`Unknown terminal: ${id}`)
    return t
  }
}
