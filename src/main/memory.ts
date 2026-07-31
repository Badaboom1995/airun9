import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import Database from 'better-sqlite3'
import type {
  MemoryAgent,
  MemoryMessage,
  MemoryRole,
  MemorySearchHit,
  MemorySessionInfo
} from '../shared/types'
import {
  parseClaudeTranscript,
  parseCodexRollout,
  parseGrokSession,
  type ParsedSession
} from './memory-adapters'

/**
 * Cross-agent conversation memory (ADR-0008 companion): every session an
 * agent CLI runs on this machine — claude, gpt (Codex), grok — is ingested
 * from the transcript files the CLI itself writes, normalized into one
 * message schema, and indexed in SQLite FTS5. The PTY scrollback is never
 * the source: it is rendered ANSI; the transcripts are structured truth.
 *
 * Ingestion is watch-driven and idempotent: a changed transcript is
 * re-parsed whole and its session's messages replaced in one transaction,
 * so partial writes, resumes, and restarts all converge to the same rows.
 */

const DB_PATH = join(homedir(), '.airun9', 'memory.db')

/** A transcript beyond this is a runaway session, not memory material */
const MAX_FILE_BYTES = 30 * 1024 * 1024
/** Transcripts stream while agents work; coalesce bursts of writes */
const INGEST_DEBOUNCE_MS = 500

interface WatchRoot {
  agent: MemoryAgent
  dir: string
  matches: (path: string) => boolean
  parse: (path: string) => ParsedSession | null
}

const ROOTS: WatchRoot[] = [
  {
    agent: 'claude',
    dir: join(homedir(), '.claude', 'projects'),
    matches: (p) => p.endsWith('.jsonl'),
    parse: parseClaudeTranscript
  },
  {
    agent: 'gpt',
    dir: join(homedir(), '.codex', 'sessions'),
    matches: (p) => basename(p).startsWith('rollout-') && p.endsWith('.jsonl'),
    parse: parseCodexRollout
  },
  {
    agent: 'grok',
    dir: join(homedir(), '.grok', 'sessions'),
    matches: (p) => basename(p) === 'updates.jsonl',
    parse: parseGrokSession
  }
]

export interface MemorySearchParams {
  query: string
  agent?: MemoryAgent
  cwd?: string
  limit: number
}

export interface MemorySessionsParams {
  agent?: MemoryAgent
  cwd?: string
  limit: number
}

export class MemoryManager extends EventEmitter {
  private db: Database.Database
  private watchers: FSWatcher[] = []
  private debounces = new Map<string, NodeJS.Timeout>()
  private queue: { path: string; root: WatchRoot }[] = []
  private draining = false
  private disposed = false

  constructor(dbPath: string = DB_PATH) {
    super()
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  /** Watch the agent session roots and backfill anything new/changed */
  start(): void {
    for (const root of ROOTS) {
      if (!existsSync(root.dir)) continue
      try {
        const watcher = watch(root.dir, { recursive: true }, (_event, filename) => {
          if (!filename) return
          const path = join(root.dir, filename.toString())
          if (root.matches(path)) this.scheduleIngest(path, root)
        })
        this.watchers.push(watcher)
      } catch (error) {
        console.error(`memory: watcher failed for ${root.dir}:`, error)
      }
      // backfill: newest sessions first so recent memory is available soonest
      const files = collectFiles(root.dir, root.matches)
        .map((path) => ({ path, mtime: statSafe(path)?.mtimeMs ?? 0 }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const { path } of files) this.enqueue(path, root)
    }
    void this.drain()
  }

  search(params: MemorySearchParams): MemorySearchHit[] {
    const match = toFtsQuery(params.query)
    if (!match) return []
    const filters: string[] = []
    const args: unknown[] = [match]
    if (params.agent) {
      filters.push('AND s.agent = ?')
      args.push(params.agent)
    }
    if (params.cwd) {
      filters.push('AND s.cwd = ?')
      args.push(params.cwd)
    }
    args.push(params.limit)
    const rows = this.db
      .prepare(
        `SELECT m.id AS messageId, m.session_id AS sessionId, s.agent, s.cwd,
                m.role, m.tool_name AS toolName, m.ts,
                snippet(messages_fts, 0, '[', ']', '…', 32) AS snippet
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ? ${filters.join(' ')}
         ORDER BY rank LIMIT ?`
      )
      .all(...args)
    return rows as MemorySearchHit[]
  }

  sessions(params: MemorySessionsParams): MemorySessionInfo[] {
    const filters: string[] = []
    const args: unknown[] = []
    if (params.agent) {
      filters.push('agent = ?')
      args.push(params.agent)
    }
    if (params.cwd) {
      filters.push('cwd = ?')
      args.push(params.cwd)
    }
    args.push(params.limit)
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT id, agent, native_id AS nativeId, cwd, file,
                started_at AS startedAt, updated_at AS updatedAt,
                message_count AS messageCount
         FROM sessions ${where}
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...args)
    return rows as MemorySessionInfo[]
  }

  messages(sessionId: string, limit: number, offset: number): MemoryMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, ordinal, role, content,
                tool_name AS toolName, ts
         FROM messages WHERE session_id = ?
         ORDER BY ordinal LIMIT ? OFFSET ?`
      )
      .all(sessionId, limit, offset)
    return rows as MemoryMessage[]
  }

  stats(): { sessions: number; messages: number; byAgent: Record<string, number> } {
    const sessions = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    const messages = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    const rows = this.db
      .prepare('SELECT agent, COUNT(*) AS n FROM sessions GROUP BY agent')
      .all() as Array<{ agent: string; n: number }>
    return {
      sessions: sessions.n,
      messages: messages.n,
      byAgent: Object.fromEntries(rows.map((r) => [r.agent, r.n]))
    }
  }

  dispose(): void {
    this.disposed = true
    for (const watcher of this.watchers) watcher.close()
    for (const timer of this.debounces.values()) clearTimeout(timer)
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        native_id TEXT NOT NULL,
        cwd TEXT,
        file TEXT NOT NULL,
        started_at INTEGER,
        updated_at INTEGER,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        ts INTEGER,
        UNIQUE(session_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
      -- ingest_state lets startup skip files already ingested at this size/mtime
      CREATE TABLE IF NOT EXISTS ingest_state (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL
      );
    `)
  }

  private scheduleIngest(path: string, root: WatchRoot): void {
    const existing = this.debounces.get(path)
    if (existing) clearTimeout(existing)
    this.debounces.set(
      path,
      setTimeout(() => {
        this.debounces.delete(path)
        this.enqueue(path, root)
        void this.drain()
      }, INGEST_DEBOUNCE_MS)
    )
  }

  private enqueue(path: string, root: WatchRoot): void {
    if (!this.queue.some((item) => item.path === path)) this.queue.push({ path, root })
  }

  /** Serial, yielding worker so a large backfill never blocks the app */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const { path, root } = this.queue.shift()!
        try {
          this.ingestFile(path, root)
        } catch (error) {
          console.error(`memory: failed to ingest ${path}:`, error)
        }
        await tick()
      }
    } finally {
      this.draining = false
    }
  }

  private ingestFile(path: string, root: WatchRoot): void {
    const stat = statSafe(path)
    if (!stat || stat.size > MAX_FILE_BYTES) return
    const state = this.db
      .prepare('SELECT size, mtime FROM ingest_state WHERE path = ?')
      .get(path) as { size: number; mtime: number } | undefined
    if (state && state.size === stat.size && state.mtime === stat.mtimeMs) return

    const parsed = root.parse(path)
    const recordState = this.db.prepare(
      'INSERT INTO ingest_state (path, size, mtime) VALUES (?, ?, ?) ' +
        'ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime'
    )
    if (!parsed) {
      recordState.run(path, stat.size, stat.mtimeMs)
      return
    }

    const sessionId = `${parsed.agent}:${parsed.nativeId}`
    const lastTs = parsed.messages.reduce<number | null>(
      (max, m) => (m.ts !== null && (max === null || m.ts > max) ? m.ts : max),
      null
    )
    const insertMessage = this.db.prepare(
      'INSERT INTO messages (session_id, ordinal, role, content, tool_name, ts) VALUES (?, ?, ?, ?, ?, ?)'
    )
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO sessions (id, agent, native_id, cwd, file, started_at, updated_at, message_count) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, file = excluded.file, ' +
            'started_at = excluded.started_at, updated_at = excluded.updated_at, ' +
            'message_count = excluded.message_count'
        )
        .run(
          sessionId,
          parsed.agent,
          parsed.nativeId,
          parsed.cwd,
          path,
          parsed.startedAt,
          lastTs ?? Math.round(stat.mtimeMs),
          parsed.messages.length
        )
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      parsed.messages.forEach((m, ordinal) =>
        insertMessage.run(sessionId, ordinal, m.role, m.content, m.toolName, m.ts)
      )
      recordState.run(path, stat.size, stat.mtimeMs)
    })()

    this.emit('updated', {
      sessionId,
      agent: parsed.agent,
      cwd: parsed.cwd,
      messageCount: parsed.messages.length
    })
  }
}

/** Turn free text into an FTS5 query that can never be a syntax error */
function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' ')
}

function statSafe(path: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(path)
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null
  } catch {
    return null
  }
}

function collectFiles(dir: string, matches: (path: string) => boolean): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && matches(path)) out.push(path)
    }
  }
  walk(dir)
  return out
}

export type { MemoryRole }
