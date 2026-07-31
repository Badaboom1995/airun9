import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle mirror of the memory DB, used by `npm run db:studio` (Drizzle
 * Studio) to browse ~/.airun9/memory.db. The authoritative DDL lives in
 * MemoryManager.migrate() — this file only describes it; keep the two in
 * sync. The messages_fts virtual table is deliberately absent: FTS5 tables
 * cannot be modeled here, and studio does not need it.
 */

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  agent: text('agent').notNull(),
  nativeId: text('native_id').notNull(),
  cwd: text('cwd'),
  file: text('file').notNull(),
  startedAt: integer('started_at'),
  updatedAt: integer('updated_at'),
  messageCount: integer('message_count').notNull().default(0)
})

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    toolName: text('tool_name'),
    ts: integer('ts')
  },
  (table) => [
    index('idx_messages_session').on(table.sessionId),
    uniqueIndex('messages_session_ordinal').on(table.sessionId, table.ordinal)
  ]
)

export const ingestState = sqliteTable('ingest_state', {
  path: text('path').primaryKey(),
  size: integer('size').notNull(),
  mtime: integer('mtime').notNull()
})
