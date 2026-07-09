import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { LayoutNode, ProjectInfo } from '../shared/types'
import type { TerminalManager } from './terminals'
import type { WorkerManager } from './workers'
import type { LayoutManager } from './layout'
import type { BlocksManager } from './blocks'

/**
 * The internal API: one dispatcher, many doors (ADR-0008). The renderer
 * calls it over IPC, agents call it over the Unix socket — same methods,
 * same shapes. Capability checks/audit log get a seam here later (ADR-0004).
 */

export interface ApiContext {
  terminals: TerminalManager
  workers: WorkerManager
  layout: LayoutManager
  blocks: BlocksManager
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
    'worker.wait': async (params) => {
      const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(params)
      const workers = await ctx.workers.wait(ids)
      return workers.map((worker) => ({
        ...worker,
        result: ctx.workers.result(worker.id).text
      }))
    },
    'worker.result': (params) => ctx.workers.result(idParam.parse(params).id),
    'worker.list': () => ctx.workers.list(),
    'worker.get': (params) => ctx.workers.get(idParam.parse(params).id),
    'worker.read': (params) => {
      const { id, tail } = readParams.parse(params)
      return ctx.workers.read(id, tail)
    },
    'worker.stop': (params) => ctx.workers.stop(idParam.parse(params).id),
    'worker.close': (params) => ctx.workers.close(idParam.parse(params).id),

    // layout is data (ADR-0001); structural integrity checked by LayoutManager
    'layout.get': () => ctx.layout.get(),
    'layout.set': (params) => {
      const { layout } = z.object({ layout: z.unknown() }).parse(params)
      return ctx.layout.set(layout as LayoutNode)
    },
    'layout.setActive': (params) => {
      const { tabsId, itemId } = z.object({ tabsId: z.string(), itemId: z.string() }).parse(params)
      ctx.layout.setActive(tabsId, itemId)
      return { ok: true }
    },
    'layout.setRatios': (params) => {
      const { splitId, ratios } = z
        .object({ splitId: z.string(), ratios: z.array(z.number().positive()) })
        .parse(params)
      ctx.layout.setRatios(splitId, ratios)
      return { ok: true }
    },
    'layout.removeItem': (params) => {
      const { itemId } = z.object({ itemId: z.string() }).parse(params)
      ctx.layout.removeItem(itemId)
      return { ok: true }
    },

    'block.list': () => ctx.blocks.list(),
    'block.bundle': (params) => {
      const { name } = z.object({ name: z.string() }).parse(params)
      return ctx.blocks.bundle(name)
    },
    'block.open': (params) => {
      const { name, position } = z
        .object({ name: z.string(), position: z.enum(['tab', 'right', 'down']).default('tab') })
        .parse(params)
      ctx.blocks.bundle(name) // throws early if unknown or broken
      return ctx.layout.addItem({ block: 'custom', config: { name } }, position)
    },
    'block.grant': (params) => {
      const { name } = z.object({ name: z.string() }).parse(params)
      return ctx.blocks.grant(name)
    },
    'block.pendingGrants': () => ctx.blocks.pendingGrantRequests(),
    'block.resolveGrant': (params) => {
      const { requestId, approved } = z
        .object({ requestId: z.string(), approved: z.boolean() })
        .parse(params)
      ctx.blocks.resolveGrant(requestId, approved)
      return { ok: true }
    }
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
