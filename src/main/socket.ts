import { createServer, type Server } from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dispatch } from './api'

/**
 * Public local API door for agents (ADR-0008): newline-delimited JSON-RPC
 * over a Unix domain socket. Protocol per line:
 *   → {"id": 1, "method": "worker.create", "params": {...}, "project": "proj_…"}
 *   ← {"id": 1, "result": {...}} | {"id": 1, "error": {"message": "..."}}
 *
 * `project` is the caller's binding (the CLI forwards AIRUN9_PROJECT_ID from
 * its terminal's env) — agents act on their own project no matter which one
 * the user is looking at.
 *
 * Auth is the socket itself for now (0700 dir, same-user only); per-caller
 * scoped tokens come with the capability model (ADR-0004).
 */

export const SOCKET_DIR = join(homedir(), '.airun9')
export const SOCKET_PATH = join(SOCKET_DIR, 'airun9.sock')

export function startSocketServer(api: Parameters<typeof dispatch>[0]): Server {
  mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 })
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)

  const server = createServer((socket) => {
    let pending = ''

    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) void handleLine(line)
      }
    })

    socket.on('error', () => socket.destroy())

    async function handleLine(line: string): Promise<void> {
      let id: unknown = null
      try {
        const request = JSON.parse(line) as {
          id?: unknown
          method?: unknown
          params?: unknown
          project?: unknown
        }
        id = request.id ?? null
        if (typeof request.method !== 'string') throw new Error('Missing method')
        const meta = {
          door: 'socket' as const,
          ...(typeof request.project === 'string' ? { projectId: request.project } : {})
        }
        const result = await dispatch(api, request.method, request.params, meta)
        socket.write(JSON.stringify({ id, result: result ?? null }) + '\n')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        socket.write(JSON.stringify({ id, error: { message } }) + '\n')
      }
    }
  })

  server.listen(SOCKET_PATH)
  return server
}

export function stopSocketServer(server: Server | null): void {
  server?.close()
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH)
    } catch {
      // best effort; a stale socket is unlinked on next start anyway
    }
  }
}
