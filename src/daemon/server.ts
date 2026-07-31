import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { DAEMON_VERSION, type DaemonCreateParams, type DaemonEventFrame } from '../shared/daemon'
import type { TerminalManager } from './terminals'

/**
 * The daemon's socket door: NDJSON request/response plus a pushed event
 * stream for clients that sent `subscribe`. Same framing as the public API
 * socket so both sides of the codebase read alike.
 */
export class DaemonServer {
  private server: Server | null = null
  private subscribers = new Set<Socket>()
  private onShutdown: (() => void) | null = null

  constructor(
    private terminals: TerminalManager,
    private socketPath: string
  ) {
    for (const event of ['created', 'data', 'exit', 'closed'] as const) {
      terminals.on(event, (payload) => this.broadcast({ event, payload }))
    }
  }

  listen(onShutdown: () => void): void {
    this.onShutdown = onShutdown
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 })
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath)

    this.server = createServer((socket) => {
      let pending = ''
      socket.on('data', (chunk) => {
        pending += chunk.toString('utf8')
        let newline: number
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          if (line) this.handleLine(socket, line)
        }
      })
      socket.on('error', () => socket.destroy())
      socket.on('close', () => this.subscribers.delete(socket))
    })
    this.server.listen(this.socketPath)
  }

  close(): void {
    this.server?.close()
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // best effort; a stale socket is unlinked on next start anyway
      }
    }
  }

  private broadcast(frame: DaemonEventFrame): void {
    if (this.subscribers.size === 0) return
    const line = JSON.stringify(frame) + '\n'
    for (const socket of this.subscribers) socket.write(line)
  }

  private handleLine(socket: Socket, line: string): void {
    let id: unknown = null
    try {
      const request = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown }
      id = request.id ?? null
      if (typeof request.method !== 'string') throw new Error('Missing method')
      const result = this.handle(socket, request.method, request.params)
      socket.write(JSON.stringify({ id, result: result ?? null }) + '\n')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      socket.write(JSON.stringify({ id, error: { message } }) + '\n')
    }
  }

  private handle(socket: Socket, method: string, params: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'hello':
        return { version: DAEMON_VERSION, pid: process.pid }
      case 'subscribe':
        this.subscribers.add(socket)
        return null
      case 'terminal.create':
        return this.terminals.create(params as DaemonCreateParams)
      case 'terminal.list':
        return this.terminals.list(typeof p.projectId === 'string' ? p.projectId : undefined)
      case 'terminal.get':
        return this.terminals.get(String(p.id))
      case 'terminal.snapshot':
        return this.terminals.snapshot(String(p.id))
      case 'terminal.read':
        return this.terminals.read(String(p.id), typeof p.tail === 'number' ? p.tail : undefined)
      case 'terminal.write':
        this.terminals.write(String(p.id), String(p.data))
        return null
      case 'terminal.resize':
        this.terminals.resize(String(p.id), Number(p.cols), Number(p.rows))
        return null
      case 'terminal.close':
        this.terminals.close(String(p.id))
        return null
      case 'terminal.kill':
        this.terminals.kill(String(p.id))
        return null
      case 'shutdown':
        if (p.killSessions !== false) this.terminals.disposeAll()
        // reply flushes before the exit scheduled below
        setTimeout(() => this.onShutdown?.(), 20)
        return null
      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }
}
