import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ArchitectureSchema, ArchitectureState } from '../shared/types'

/** Repo-relative location of the agent-maintained architecture schema */
export const ARCHITECTURE_FILE = join('.airun9', 'architecture.json')

// Loose validation: require just enough shape to render; passthrough keeps
// agent-invented fields (tags, status, metrics...) intact for future use.
const schemaShape = z
  .object({
    version: z.number(),
    updatedAt: z.string().optional(),
    groups: z.array(z.object({ id: z.string(), title: z.string() }).passthrough()).optional(),
    modules: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          path: z.string().optional(),
          group: z.string().optional(),
          loc: z.number().optional(),
          summary: z.string().optional()
        })
        .passthrough()
    ),
    edges: z
      .array(
        z.object({ from: z.string(), to: z.string(), label: z.string().optional() }).passthrough()
      )
      .optional()
  })
  .passthrough()

/**
 * Watches every open project's .airun9/architecture.json (one stat-polling
 * watch each) and emits 'changed' with the fresh ArchitectureState, tagged
 * with its projectId. Uses watchFile because the file may not exist yet and
 * agents write via rename, both of which break fs.watch on a plain handle.
 */
export class ArchitectureManager extends EventEmitter {
  /** projectId -> { path, listener } */
  private watched = new Map<string, { path: string; listener: () => void }>()

  watch(projectId: string, path: string): void {
    if (this.watched.get(projectId)?.path === path) return
    this.unwatch(projectId)
    const listener = (): void => {
      this.emit('changed', this.get(projectId))
    }
    this.watched.set(projectId, { path, listener })
    watchFile(join(path, ARCHITECTURE_FILE), { interval: 1500 }, listener)
    this.emit('changed', this.get(projectId))
  }

  unwatch(projectId: string): void {
    const entry = this.watched.get(projectId)
    if (!entry) return
    unwatchFile(join(entry.path, ARCHITECTURE_FILE), entry.listener)
    this.watched.delete(projectId)
  }

  get(projectId: string | null): ArchitectureState {
    const entry = projectId ? this.watched.get(projectId) : undefined
    if (!projectId || !entry) return { projectId: null, project: null, schema: null, error: null }
    const base = { projectId, project: entry.path }
    const file = join(entry.path, ARCHITECTURE_FILE)
    if (!existsSync(file)) return { ...base, schema: null, error: null }
    try {
      const parsed = schemaShape.parse(JSON.parse(readFileSync(file, 'utf8')))
      return { ...base, schema: parsed as ArchitectureSchema, error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ...base, schema: null, error: message }
    }
  }

  dispose(): void {
    for (const projectId of [...this.watched.keys()]) this.unwatch(projectId)
  }
}
