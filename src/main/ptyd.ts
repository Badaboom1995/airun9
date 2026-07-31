import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DAEMON_VERSION,
  PTYD_LOG_PATH,
  PTYD_SOCKET_PATH,
  type DaemonHello
} from '../shared/daemon'

/**
 * Daemon supervisor + low-level client (docs/plans/pty-daemon.md).
 *
 * ensure() adopts a running daemon through a hello handshake, or spawns one:
 * detached in production (PTYs survive IDE restarts), attached with a
 * parent-watchdog in dev (hot reloads must not leak stale-code daemons;
 * AIRUN9_PTYD_PERSIST=1 opts dev into the production behavior).
 *
 * ELECTRON_RUN_AS_NODE runs the daemon from the Electron binary itself, so
 * the Electron-ABI node-pty build loads without a second native compile.
 */

const MAX_LOG_BYTES = 5 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 1000
const SPAWN_READY_TIMEOUT_MS = 5000

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export class PtydClient extends EventEmitter {
  private socket: Socket | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private intentionalClose = false

  constructor(
    private isDev: boolean,
    private daemonScript = join(__dirname, 'daemon.js')
  ) {
    super()
  }

  get connected(): boolean {
    return this.socket !== null
  }

  /** Adopt a live daemon or spawn one, then subscribe to its event stream. */
  async ensure(): Promise<void> {
    if (this.socket) return
    let socket = await this.tryConnect()
    if (socket) {
      const hello = await this.handshake(socket)
      if (hello.version !== DAEMON_VERSION) {
        // Stale daemon from an older build. No handoff protocol yet (see
        // plan, "later") — replace it and its sessions, loudly.
        console.warn(
          `[ptyd] running daemon is v${hello.version}, expected v${DAEMON_VERSION} — restarting sessions`
        )
        this.request0(socket, 'shutdown', { killSessions: true })
        await new Promise<void>((resolve) => {
          socket!.once('close', () => resolve())
          setTimeout(resolve, 1000)
        })
        socket = null
      }
    }
    if (!socket) {
      this.spawnDaemon()
      socket = await this.waitForDaemon()
      await this.handshake(socket)
    }
    this.adopt(socket)
    await this.request('subscribe')
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket) throw new Error('pty daemon is not connected')
    const id = this.nextId++
    const line = JSON.stringify({ id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket!.write(line)
    })
  }

  /** Fire-and-forget: no id, so the daemon's reply line is ignored. */
  send(method: string, params?: unknown): void {
    this.socket?.write(JSON.stringify({ method, params }) + '\n')
  }

  /** Prod quit: detach and leave the daemon (and every agent in it) running. */
  disconnect(): void {
    this.intentionalClose = true
    this.socket?.end()
    this.socket = null
  }

  /** Dev quit / "Quit Completely": stop the daemon and all its sessions. */
  shutdownDaemon(): void {
    this.intentionalClose = true
    this.send('shutdown', { killSessions: true })
    this.socket?.end()
    this.socket = null
  }

  private adopt(socket: Socket): void {
    this.socket = socket
    this.intentionalClose = false
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      let newline: number
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line) this.handleFrame(line)
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      for (const pending of this.pending.values()) {
        pending.reject(new Error('pty daemon connection closed'))
      }
      this.pending.clear()
      // A daemon crash killed its PTYs with it (uncaughtException handler).
      // Surface it so TerminalClient can reconcile, then self-heal.
      if (!this.intentionalClose) {
        console.error('[ptyd] connection lost, respawning daemon')
        this.emit('disconnected')
        void this.ensure()
          .then(() => this.emit('reconnected'))
          .catch((error) => console.error('[ptyd] respawn failed:', error))
      }
    })
  }

  private handleFrame(line: string): void {
    let frame: { id?: unknown; result?: unknown; error?: { message?: string }; event?: string }
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (typeof frame.event === 'string') {
      this.emit('event', frame.event, (frame as { payload?: unknown }).payload)
      return
    }
    if (typeof frame.id !== 'number') return // reply to a fire-and-forget send
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    if (frame.error) pending.reject(new Error(frame.error.message ?? 'daemon error'))
    else pending.resolve(frame.result)
  }

  private tryConnect(): Promise<Socket | null> {
    return new Promise((resolve) => {
      if (!existsSync(PTYD_SOCKET_PATH)) return resolve(null)
      const socket = connect(PTYD_SOCKET_PATH)
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(null)
      }, CONNECT_TIMEOUT_MS)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', () => {
        clearTimeout(timer)
        socket.destroy()
        // stale socket file from a dead daemon; clear it for the spawn path
        try {
          unlinkSync(PTYD_SOCKET_PATH)
        } catch {
          // fine — the daemon unlinks on listen anyway
        }
        resolve(null)
      })
    })
  }

  /** One-shot request on a socket not yet adopted (handshake path) */
  private handshake(socket: Socket): Promise<DaemonHello> {
    return new Promise((resolve, reject) => {
      let buffered = ''
      const timer = setTimeout(() => {
        cleanup()
        socket.destroy()
        reject(new Error('daemon hello timed out'))
      }, CONNECT_TIMEOUT_MS)
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString('utf8')
        const newline = buffered.indexOf('\n')
        if (newline === -1) return
        cleanup()
        try {
          const frame = JSON.parse(buffered.slice(0, newline)) as { result?: DaemonHello }
          if (!frame.result) throw new Error('malformed hello')
          resolve(frame.result)
        } catch (error) {
          socket.destroy()
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.off('data', onData)
      }
      socket.on('data', onData)
      socket.write(JSON.stringify({ id: 0, method: 'hello' }) + '\n')
    })
  }

  private request0(socket: Socket, method: string, params?: unknown): void {
    socket.write(JSON.stringify({ method, params }) + '\n')
  }

  private spawnDaemon(): void {
    if (!existsSync(this.daemonScript)) {
      throw new Error(`pty daemon bundle missing at ${this.daemonScript}`)
    }
    const persist = !this.isDev || process.env.AIRUN9_PTYD_PERSIST === '1'
    const args = [this.daemonScript, `--socket=${PTYD_SOCKET_PATH}`]
    if (!persist) args.push(`--watch-parent=${process.pid}`)

    // Raise the fd limit before exec: macOS's 256 soft default starves a
    // daemon hosting many worktrees' PTYs (node-pty EMFILE).
    const shellArgs = [
      '-c',
      'ulimit -n 1048576 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true; exec "$@"',
      'sh',
      process.execPath,
      ...args
    ]

    const logFd = persist ? this.openLogFd() : null
    const child = spawn('/bin/sh', shellArgs, {
      detached: persist,
      stdio: logFd !== null ? ['ignore', logFd, logFd] : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    if (child.stdout && child.stderr) {
      child.stdout.pipe(process.stdout)
      child.stderr.pipe(process.stderr)
    }
    if (persist) child.unref()
    console.log(`[ptyd] spawned daemon pid ${child.pid} (persist: ${persist})`)
  }

  private openLogFd(): number {
    mkdirSync(dirname(PTYD_LOG_PATH), { recursive: true, mode: 0o700 })
    try {
      if (statSync(PTYD_LOG_PATH).size > MAX_LOG_BYTES) {
        renameSync(PTYD_LOG_PATH, `${PTYD_LOG_PATH}.1`)
      }
    } catch {
      // no log yet
    }
    return openSync(PTYD_LOG_PATH, 'a')
  }

  private async waitForDaemon(): Promise<Socket> {
    const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const socket = await this.tryConnect()
      if (socket) return socket
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(
      `pty daemon socket did not become ready within ${SPAWN_READY_TIMEOUT_MS}ms — see ${PTYD_LOG_PATH}`
    )
  }
}
