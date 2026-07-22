import { EventEmitter } from 'node:events'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalSnapshot
} from '../shared/types'
import { PtydClient } from './ptyd'

export interface CreateTerminalOptions {
  /** Project this terminal (and any agent inside it) is bound to */
  projectId: string
  cwd: string
  title?: string
  /** Run this command via an interactive login shell instead of a plain shell */
  command?: string
  env?: Record<string, string>
  workerId?: string
}

/**
 * Client to the PTY daemon, which owns every PTY so sessions survive IDE
 * restarts (docs/plans/pty-daemon.md). Same surface the in-process
 * TerminalManager had, with three honest asyncs:
 *
 * - list/get stay sync off a mirror of TerminalInfo, seeded by connect()
 *   and maintained by the daemon's event stream
 * - create/snapshot/read await the daemon (ids and scrollback live there)
 * - write/resize/kill/close are fire-and-forget sends
 */
export class TerminalClient extends EventEmitter {
  private mirror = new Map<string, TerminalInfo>()
  private client: PtydClient

  constructor(
    private baseEnv: () => Record<string, string>,
    isDev: boolean
  ) {
    super()
    this.client = new PtydClient(isDev)

    this.client.on('event', (event: string, payload: unknown) => {
      switch (event) {
        case 'created': {
          const info = payload as TerminalInfo
          this.mirror.set(info.id, info)
          this.emit('created', info)
          break
        }
        case 'data':
          this.emit('data', payload as TerminalDataEvent)
          break
        case 'exit': {
          const { id, exitCode } = payload as TerminalExitEvent
          const info = this.mirror.get(id)
          if (info) {
            info.status = 'exited'
            info.exitCode = exitCode
          }
          this.emit('exit', payload)
          break
        }
        case 'closed': {
          const { id } = payload as { id: string }
          this.mirror.delete(id)
          this.emit('closed', payload)
          break
        }
      }
    })

    // Daemon crash takes its PTYs with it — reflect that instead of showing
    // ghost terminals. The client is already respawning a fresh daemon.
    this.client.on('disconnected', () => {
      for (const info of this.mirror.values()) {
        if (info.status !== 'exited') {
          info.status = 'exited'
          info.exitCode = -1
          this.emit('exit', { id: info.id, exitCode: -1 } satisfies TerminalExitEvent)
        }
      }
    })
    this.client.on('reconnected', () => void this.seed())
  }

  /** Adopt-or-spawn the daemon and load its live sessions. Await before use. */
  async connect(): Promise<void> {
    await this.client.ensure()
    await this.seed()
  }

  private async seed(): Promise<void> {
    const live = (await this.client.request('terminal.list')) as TerminalInfo[]
    for (const info of live) this.mirror.set(info.id, info)
  }

  async create(options: CreateTerminalOptions): Promise<TerminalInfo> {
    const info = (await this.client.request('terminal.create', {
      ...options,
      env: { ...this.baseEnv(), ...options.env }
    })) as TerminalInfo
    this.mirror.set(info.id, info)
    return info
  }

  list(projectId?: string): TerminalInfo[] {
    const all = [...this.mirror.values()]
    return projectId ? all.filter((t) => t.projectId === projectId) : all
  }

  get(id: string): TerminalInfo {
    const info = this.mirror.get(id)
    if (!info) throw new Error(`Unknown terminal: ${id}`)
    return info
  }

  snapshot(id: string): Promise<TerminalSnapshot> {
    return this.client.request('terminal.snapshot', { id }) as Promise<TerminalSnapshot>
  }

  /** Tail of the scrollback, for API consumers (agents reading output) */
  read(id: string, tailChars?: number): Promise<{ data: string; seq: number }> {
    return this.client.request('terminal.read', { id, tail: tailChars }) as Promise<{
      data: string
      seq: number
    }>
  }

  write(id: string, data: string): void {
    this.client.send('terminal.write', { id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    const info = this.mirror.get(id)
    if (info && cols > 0 && rows > 0) {
      info.cols = cols
      info.rows = rows
    }
    this.client.send('terminal.resize', { id, cols, rows })
  }

  /** Kill the process (if running) and drop the terminal entirely */
  close(id: string): void {
    this.client.send('terminal.close', { id })
  }

  /** Kill the process but keep the terminal (worker stop) */
  kill(id: string): void {
    this.client.send('terminal.kill', { id })
  }

  /** Dev quit (or a future "Quit Completely"): daemon and sessions stop. */
  shutdownDaemon(): void {
    this.client.shutdownDaemon()
  }

  /** Prod quit: detach — daemon and agents keep running for the next launch. */
  detach(): void {
    this.client.disconnect()
  }
}
