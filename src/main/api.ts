import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { ProjectInfo } from '../shared/types'
import type { TerminalManager } from './terminals'
import type { WorkerManager } from './workers'

/**
 * The internal API: one dispatcher, many doors (ADR-0008). The renderer
 * calls it over IPC, agents call it over the Unix socket — same methods,
 * same shapes. Capability checks/audit log get a seam here later (ADR-0004).
 */

export interface ApiContext {
  terminals: TerminalManager
  workers: WorkerManager
  getProject: () => ProjectInfo | null
  setProject: (project: ProjectInfo) => void
}

type Handler = (params: unknown) => unknown

const idParam = z.object({ id: z.string() })
const readParams = z.object({ id: z.string(), tail: z.number().int().positive().optional() })

function expandHome(path: string): string {
  return path.startsWith('~') ? resolve(homedir(), path.slice(2) || '.') : resolve(path)
}

export function buildApi(ctx: ApiContext): Record<string, Handler> {
  const requireProject = (): ProjectInfo => {
    const project = ctx.getProject()
    if (!project) throw new Error('No project is open')
    return project
  }

  return {
    'app.ping': () => ({ pong: true, pid: process.pid }),

    'project.open': (params) => {
      const { path } = z.object({ path: z.string() }).parse(params)
      const abs = expandHome(path)
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new Error(`Not a directory: ${abs}`)
      }
      const project: ProjectInfo = { path: abs, name: basename(abs) }
      ctx.setProject(project)
      return project
    },

    'project.get': () => ctx.getProject(),

    'terminal.create': (params) => {
      const { cwd, title } = z
        .object({ cwd: z.string().optional(), title: z.string().optional() })
        .parse(params ?? {})
      return ctx.terminals.create({
        cwd: cwd ? expandHome(cwd) : requireProject().path,
        title
      })
    },
    'terminal.list': () => ctx.terminals.list(),
    'terminal.get': (params) => ctx.terminals.get(idParam.parse(params).id),
    'terminal.snapshot': (params) => ctx.terminals.snapshot(idParam.parse(params).id),
    'terminal.read': (params) => {
      const { id, tail } = readParams.parse(params)
      return ctx.terminals.read(id, tail)
    },
    'terminal.write': (params) => {
      const { id, data } = z.object({ id: z.string(), data: z.string() }).parse(params)
      ctx.terminals.write(id, data)
      return { ok: true }
    },
    'terminal.resize': (params) => {
      const { id, cols, rows } = z
        .object({ id: z.string(), cols: z.number().int(), rows: z.number().int() })
        .parse(params)
      ctx.terminals.resize(id, cols, rows)
      return { ok: true }
    },
    'terminal.close': (params) => {
      ctx.terminals.close(idParam.parse(params).id)
      return { ok: true }
    },

    // read-only scouts spawn without approval
    'worker.scout': (params) => {
      const options = z
        .object({
          prompt: z.string().min(1),
          name: z.string().optional(),
          count: z.number().int().min(1).max(4).default(1)
        })
        .parse(params)
      return ctx.workers.createScouts(options, requireProject())
    },
    // mutating workers only spawn through the user's in-app approval
    'worker.request': (params) => {
      const options = z
        .object({
          prompt: z.string().min(1),
          name: z.string().optional(),
          count: z.number().int().min(1).max(4).default(1),
          reason: z.string().optional(),
          recommendedMode: z.enum(['bypass', 'edits', 'manual']),
          recommendedLocation: z.enum(['shared', 'worktree']).default('shared')
        })
        .parse(params)
      requireProject()
      return ctx.workers.requestFull(options)
    },
    'worker.pendingRequests': () => ctx.workers.pendingRequests(),
    'worker.resolveRequest': (params) => {
      const decision = z
        .object({
          requestId: z.string(),
          approved: z.boolean(),
          mode: z.enum(['bypass', 'edits', 'manual']),
          location: z.enum(['shared', 'worktree'])
        })
        .parse(params)
      return ctx.workers.resolveRequest(decision, requireProject())
    },
    'worker.hookEvent': (params) => {
      const { workerId, event, transcriptPath } = z
        .object({
          workerId: z.string(),
          event: z.enum(['stop', 'prompt-submit']),
          transcriptPath: z.string().optional()
        })
        .parse(params)
      ctx.workers.hookEvent(workerId, event, transcriptPath)
      return { ok: true }
    },
    'worker.prompt': (params) => {
      const { id, prompt } = z.object({ id: z.string(), prompt: z.string().min(1) }).parse(params)
      return ctx.workers.prompt(id, prompt)
    },
    'worker.result': (params) => ctx.workers.result(idParam.parse(params).id),
    'worker.list': () => ctx.workers.list(),
    'worker.get': (params) => ctx.workers.get(idParam.parse(params).id),
    'worker.read': (params) => {
      const { id, tail } = readParams.parse(params)
      return ctx.workers.read(id, tail)
    },
    'worker.stop': (params) => ctx.workers.stop(idParam.parse(params).id)
  }
}

export async function dispatch(
  api: Record<string, Handler>,
  method: string,
  params: unknown
): Promise<unknown> {
  const handler = api[method]
  if (!handler) throw new Error(`Unknown method: ${method}`)
  return handler(params)
}
