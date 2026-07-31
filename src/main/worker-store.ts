import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WorkerInfo } from '../shared/types'

const STORE_DIR = join(homedir(), '.airun9')
const STORE_PATH = join(STORE_DIR, 'workers.json')

/**
 * Durable worker registry (docs/plans/pty-daemon.md phase 3). The daemon
 * keeps the PTYs alive across IDE restarts, but the *meaning* of each
 * terminal — "term_X is worker 'fix-login' in project Y" — lives in
 * WorkerManager's map. This file is that map on disk, rewritten on every
 * mutation and reconciled against the daemon's live sessions on startup.
 *
 * JSON for now, same write-then-rename crash safety as BlockStorage;
 * migrates to the ADR-0010 SQLite store when that lands broadly.
 */

export function loadWorkers(): WorkerInfo[] {
  if (!existsSync(STORE_PATH)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return Array.isArray(parsed) ? (parsed as WorkerInfo[]) : []
  } catch {
    // an unreadable store starts fresh rather than blocking launch
    return []
  }
}

export function saveWorkers(workers: Iterable<WorkerInfo>): void {
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(`${STORE_PATH}.tmp`, JSON.stringify([...workers], null, 2))
  renameSync(`${STORE_PATH}.tmp`, STORE_PATH)
}
