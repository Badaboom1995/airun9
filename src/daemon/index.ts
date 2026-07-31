import { PTYD_SOCKET_PATH } from '../shared/daemon'
import { TerminalManager } from './terminals'
import { DaemonServer } from './server'

/**
 * PTY daemon entry (docs/plans/pty-daemon.md). Spawned by the supervisor in
 * src/main/ptyd.ts — detached in production so PTYs survive IDE restarts,
 * attached in dev so hot-reloads can't leak stale-code daemons. Runs under
 * ELECTRON_RUN_AS_NODE, so the Electron-ABI node-pty build loads as-is.
 *
 * Has no window: stdout/stderr are wired to ~/.airun9/pty-daemon.log by the
 * supervisor in production, or piped into the dev terminal in dev.
 */

function log(message: string): void {
  process.stderr.write(`[ptyd ${new Date().toISOString()}] ${message}\n`)
}

function socketArg(): string {
  for (const arg of process.argv) {
    if (arg.startsWith('--socket=')) return arg.slice('--socket='.length)
  }
  return PTYD_SOCKET_PATH
}

/** Dev mode only: die with the IDE. electron-vite restarts don't reliably
 * fire before-quit, and a surviving daemon running stale code is the one
 * thing dev mode must never produce. */
function watchParentArg(): number | null {
  for (const arg of process.argv) {
    if (arg.startsWith('--watch-parent=')) {
      const pid = Number(arg.slice('--watch-parent='.length))
      return Number.isInteger(pid) && pid > 0 ? pid : null
    }
  }
  return null
}

const terminals = new TerminalManager()
const server = new DaemonServer(terminals, socketArg())

let shuttingDown = false
function shutdown(reason: string, killSessions: boolean): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)
  if (killSessions) terminals.disposeAll()
  server.close()
  // node-pty's exit handlers get a beat to reap children
  setTimeout(() => process.exit(0), 100)
}

server.listen(() => shutdown('shutdown request', false))
log(`listening on ${socketArg()} (pid ${process.pid})`)

const parentPid = watchParentArg()
if (parentPid) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0) // signal 0 = liveness probe only
    } catch {
      shutdown('parent gone', true)
    }
  }, 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT', true))
process.on('SIGTERM', () => shutdown('SIGTERM', true))
// A crash must not strand PTYs with no owner to ever kill them
process.on('uncaughtException', (error) => {
  log(`uncaught: ${error.stack ?? error.message}`)
  shutdown('uncaughtException', true)
})
