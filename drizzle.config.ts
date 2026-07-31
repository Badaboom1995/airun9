import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'drizzle-kit'

/**
 * Dev-only config for `npm run db:studio` — a web UI over the agent-memory
 * DB. The schema is created and migrated by the app itself
 * (MemoryManager.migrate()), NOT by drizzle-kit: never run `drizzle-kit
 * push/migrate` against this DB — it does not know about the messages_fts
 * virtual table and its triggers.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/memory-schema.ts',
  dbCredentials: { url: join(homedir(), '.airun9', 'memory.db') }
})
