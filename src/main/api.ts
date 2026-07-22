import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
  BROWSER_BLOCK,
  BUILTIN_OPENABLE_BLOCKS,
  type FileEntry,
  type LayoutNode,
  type LayoutTabItem,
  type ProjectInfo
} from '../shared/types'
import type { BrowserManager } from './browser'
import type { TerminalClient } from './terminals'
import type { WorkerManager } from './workers'
import type { WorktreeManager } from './worktrees'
import type { LayoutManager } from './layout'
import type { ProjectManager } from './projects'
import { BUILTIN_BLOCK_INFOS, type BlocksManager } from './blocks'
import { GLOBAL_SCOPE, type BlockStorage } from './storage'
import type { ArchitectureManager } from './architecture'
import type { MemoryManager } from './memory'

/**
 * The internal API: one dispatcher, many doors (ADR-0008). The renderer
 * calls it over IPC, agents call it over the Unix socket — same methods,
 * same shapes. Capability checks/audit log get a seam here later (ADR-0004).
 *
 * Multi-project scoping: every call resolves a project. The socket door
 * passes the caller's binding (terminals carry AIRUN9_PROJECT_ID; the CLI
 * forwards it as meta), so agents always act on THEIR project. The IPC door
 * passes no meta and defaults to the active project — the renderer only
 * ever acts on what the user is looking at.
 */

export interface ApiContext {
  projects: ProjectManager
  terminals: TerminalClient
  browsers: BrowserManager
  workers: WorkerManager
  worktrees: WorktreeManager
  layout: LayoutManager
  blocks: BlocksManager
  storage: BlockStorage
  architecture: ArchitectureManager
  memory: MemoryManager
}

/** Per-call context a door attaches to the request */
export interface CallMeta {
  /** the caller's project binding (socket door); absent = active project */
  projectId?: string
  /** which door the call came through; user-consent methods (approval
   * resolution, direct worktree create) only open from 'ipc' */
  door?: 'ipc' | 'socket'
}

type Handler = (params: unknown, meta: CallMeta) => unknown

const idParam = z.object({ id: z.string() })
const readParams = z.object({ id: z.string(), tail: z.number().int().positive().optional() })

function expandHome(path: string): string {
  return path.startsWith('~') ? resolve(homedir(), path.slice(2) || '.') : resolve(path)
}

/** fs.read returns at most this many bytes; the rest is flagged `truncated` */
const FS_READ_CAP = 256 * 1024

export function buildApi(ctx: ApiContext): Record<string, Handler> {
  /** The caller's project: its binding if it has one, else the active one */
  const requireProject = (meta: CallMeta): ProjectInfo => {
    if (meta.projectId) return ctx.projects.get(meta.projectId)
    const project = ctx.projects.active()
    if (!project) throw new Error('No project is open')
    return project
  }

  const optionalProject = (meta: CallMeta): ProjectInfo | null => {
    try {
      return requireProject(meta)
    } catch {
      return null
    }
  }

  const storageScope = (scope: 'project' | 'global', meta: CallMeta): string => {
    if (scope === 'global') return GLOBAL_SCOPE
    return optionalProject(meta)?.id ?? GLOBAL_SCOPE
  }

  /** Approval decisions and other user-consent methods must come from the
   * app UI — an agent must not be able to approve its own request */
  const requireUserDoor = (meta: CallMeta): void => {
    if (meta.door === 'socket') {
      throw new Error('This method is only available to the app UI, not the socket API')
    }
  }

  /** Explicit project override (the rail acts on background projects too),
   * else the caller's binding / active project */
  const projectOrBound = (projectId: string | undefined, meta: CallMeta): ProjectInfo =>
    projectId ? ctx.projects.get(projectId) : requireProject(meta)

  const resolveInProject = (project: ProjectInfo, relPath: string): string => {
    const abs = resolve(project.path, relPath)
    if (abs !== project.path && !abs.startsWith(project.path + sep)) {
      throw new Error(`Path escapes the project: ${relPath}`)
    }
    return abs
  }

  return {
    'app.ping': () => ({ pong: true, pid: process.pid }),

    // several projects are open at once; each owns its layout, terminals
    // and agents. open dedupes by realpath and activates; close kills the
    // project's sessions (wired in index.ts via the manager's events)
    'project.open': (params) => {
      const { path } = z.object({ path: z.string() }).parse(params)
      return ctx.projects.open(expandHome(path))
    },
    'project.get': (_params, meta) => optionalProject(meta),
    'project.list': () => ctx.projects.state(),
    'project.activate': (params) => ctx.projects.activate(idParam.parse(params).id),
    'project.close': (params) => {
      ctx.projects.close(idParam.parse(params).id)
      return { ok: true }
    },

    // read-only project filesystem (files block; blocks may declare these).
    // Paths are project-relative and confined to the project root.
    'fs.list': (params, meta) => {
      const { path } = z.object({ path: z.string().default('.') }).parse(params ?? {})
      const project = requireProject(meta)
      const abs = resolveInProject(project, path)
      const entries = readdirSync(abs, { withFileTypes: true })
        .map((dirent): FileEntry | null => {
          let stat // follows symlinks so linked dirs expand; broken links are skipped
          try {
            stat = statSync(join(abs, dirent.name))
          } catch {
            return null
          }
          const type = stat.isDirectory() ? ('dir' as const) : ('file' as const)
          return {
            name: dirent.name,
            path: relative(project.path, join(abs, dirent.name)).split(sep).join('/'),
            type,
            size: type === 'file' ? stat.size : null
          }
        })
        .filter((entry): entry is FileEntry => entry !== null)
      return entries.sort(
        (a, b) =>
          Number(a.type === 'file') - Number(b.type === 'file') || a.name.localeCompare(b.name)
      )
    },
    'fs.read': (params, meta) => {
      const { path } = z.object({ path: z.string().min(1) }).parse(params)
      const abs = resolveInProject(requireProject(meta), path)
      const stat = statSync(abs)
      if (!stat.isFile()) throw new Error(`Not a file: ${path}`)
      const fd = openSync(abs, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, FS_READ_CAP))
        const read = readSync(fd, buffer, 0, buffer.length, 0)
        const head = buffer.subarray(0, read)
        const binary = head.includes(0)
        return {
          path,
          content: binary ? '' : head.toString('utf8'),
          size: stat.size,
          truncated: stat.size > FS_READ_CAP,
          binary
        }
      } finally {
        closeSync(fd)
      }
    },

    'terminal.create': (params, meta) => {
      const { cwd, title, projectId } = z
        .object({
          cwd: z.string().optional(),
          title: z.string().optional(),
          projectId: z.string().optional()
        })
        .parse(params ?? {})
      const project = projectOrBound(projectId, meta)
      return ctx.terminals.create({
        projectId: project.id,
        cwd: cwd ? expandHome(cwd) : project.path,
        title
      })
    },
    // default: the caller's project; all:true = every project (renderer
    // needs the full set for background badges and stores)
    'terminal.list': (params, meta) => {
      const { all } = z.object({ all: z.boolean().default(false) }).parse(params ?? {})
      return ctx.terminals.list(all ? undefined : requireProject(meta).id)
    },
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

    // embedded browser pages; created blocks appear in the layout via the
    // manager's 'created' event (same lifecycle wiring as terminals)
    'browser.create': (params, meta) => {
      const { url, position } = z
        .object({
          url: z.string().optional(),
          position: z.enum(['tab', 'right', 'down', 'left', 'up']).default('tab')
        })
        .parse(params ?? {})
      return ctx.browsers.create({ projectId: requireProject(meta).id, url, position })
    },
    // renderer-internal: the BrowserBlock reports its <webview>'s guest
    'browser.attach': (params) => {
      const { id, webContentsId } = z
        .object({ id: z.string(), webContentsId: z.number().int() })
        .parse(params)
      return ctx.browsers.attach(id, webContentsId)
    },
    'browser.list': (params, meta) => {
      const { all } = z.object({ all: z.boolean().default(false) }).parse(params ?? {})
      return ctx.browsers.list(all ? undefined : requireProject(meta).id)
    },
    'browser.get': (params) => ctx.browsers.get(idParam.parse(params).id),
    'browser.navigate': (params) => {
      const { id, url } = z.object({ id: z.string(), url: z.string().min(1) }).parse(params)
      return ctx.browsers.navigate(id, url)
    },
    'browser.back': (params) => {
      ctx.browsers.back(idParam.parse(params).id)
      return { ok: true }
    },
    'browser.forward': (params) => {
      ctx.browsers.forward(idParam.parse(params).id)
      return { ok: true }
    },
    'browser.reload': (params) => {
      ctx.browsers.reload(idParam.parse(params).id)
      return { ok: true }
    },
    'browser.stop': (params) => {
      ctx.browsers.stop(idParam.parse(params).id)
      return { ok: true }
    },
    'browser.screenshot': (params) => {
      const { id, path } = z.object({ id: z.string(), path: z.string().optional() }).parse(params)
      return ctx.browsers.screenshot(id, path ? expandHome(path) : undefined)
    },
    'browser.text': (params) => ctx.browsers.text(idParam.parse(params).id),
    'browser.console': (params) => {
      const { id, tail } = readParams.parse(params)
      return ctx.browsers.console(id, tail)
    },
    'browser.close': (params) => {
      ctx.browsers.close(idParam.parse(params).id)
      return { ok: true }
    },

    // read-only scouts spawn without approval
    'worker.scout': (params, meta) => {
      const options = z
        .object({
          prompt: z.string().min(1),
          name: z.string().optional(),
          count: z.number().int().min(1).max(4).default(1)
        })
        .parse(params)
      return ctx.workers.createScouts(options, requireProject(meta))
    },
    // mutating workers only spawn through the user's in-app approval; the
    // request captures the caller's project so approving from another one
    // still spawns where the work belongs
    'worker.request': (params, meta) => {
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
      return ctx.workers.requestFull(options, requireProject(meta))
    },
    'worker.pendingRequests': () => ctx.workers.pendingRequests(),
    'worker.resolveRequest': (params, meta) => {
      requireUserDoor(meta)
      const decision = z
        .object({
          requestId: z.string(),
          approved: z.boolean(),
          mode: z.enum(['bypass', 'edits', 'manual']),
          location: z.enum(['shared', 'worktree']),
          worktreeId: z.string().optional()
        })
        .parse(params)
      return ctx.workers.resolveRequest(decision)
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
    'worker.list': (params, meta) => {
      const { all } = z.object({ all: z.boolean().default(false) }).parse(params ?? {})
      return ctx.workers.list(all ? undefined : requireProject(meta).id)
    },
    'worker.get': (params) => ctx.workers.get(idParam.parse(params).id),
    'worker.read': (params) => {
      const { id, tail } = readParams.parse(params)
      return ctx.workers.read(id, tail)
    },
    'worker.stop': (params) => ctx.workers.stop(idParam.parse(params).id),
    'worker.close': (params) => ctx.workers.close(idParam.parse(params).id),

    // worktrees are first-class (ADR-0011); git is the truth — list is a
    // fresh scan. Create/remove are gated per ADR-0004: agents request and
    // wait for the user's card; the UI's create dialog is itself consent.
    'worktree.list': (params, meta) => {
      const { projectId } = z.object({ projectId: z.string().optional() }).parse(params ?? {})
      return ctx.worktrees.list(projectOrBound(projectId, meta))
    },
    'worktree.request': (params, meta) => {
      const options = z
        .object({
          name: z.string().min(1),
          count: z.number().int().min(1).max(8).default(1),
          from: z.string().optional(),
          reason: z.string().optional()
        })
        .parse(params)
      return ctx.worktrees.requestCreate(options, requireProject(meta))
    },
    'worktree.requestRemove': (params, meta) => {
      const { id, reason, projectId } = z
        .object({
          id: z.string().min(1),
          reason: z.string().optional(),
          projectId: z.string().optional()
        })
        .parse(params)
      return ctx.worktrees.requestRemove({ idOrName: id, reason }, projectOrBound(projectId, meta))
    },
    // switch the user's view to a worktree context — UI door only (agents
    // must not yank the user's workspace around)
    'worktree.activate': (params, meta) => {
      requireUserDoor(meta)
      const { id, projectId } = z
        .object({ id: z.string().min(1), projectId: z.string().optional() })
        .parse(params)
      return ctx.worktrees.activate(id, projectOrBound(projectId, meta))
    },
    'worktree.pendingRequests': () => ctx.worktrees.pendingRequests(),
    'worktree.resolveRequest': (params, meta) => {
      requireUserDoor(meta)
      const decision = z
        .object({
          requestId: z.string(),
          approved: z.boolean(),
          deleteBranch: z.boolean().optional()
        })
        .parse(params)
      return ctx.worktrees.resolveRequest(decision)
    },
    'worktree.create': (params, meta) => {
      requireUserDoor(meta)
      const { projectId, ...options } = z
        .object({
          name: z.string().min(1),
          from: z.string().optional(),
          bootstrapCmd: z.string().optional(),
          projectId: z.string().optional()
        })
        .parse(params)
      return ctx.worktrees.create(options, projectOrBound(projectId, meta))
    },
    // agents may read the remembered bootstrap command as their default
    'worktree.bootstrapCmd': (params, meta) => {
      const { projectId } = z.object({ projectId: z.string().optional() }).parse(params ?? {})
      return { cmd: ctx.worktrees.bootstrapCmd(projectOrBound(projectId, meta).id) }
    },
    'worktree.setBootstrapCmd': (params, meta) => {
      requireUserDoor(meta)
      const { cmd } = z.object({ cmd: z.string() }).parse(params)
      ctx.worktrees.setBootstrapCmd(requireProject(meta).id, cmd)
      return { ok: true }
    },

    // layout is data (ADR-0001); structural integrity checked by
    // LayoutManager. One tree per project — calls act on the caller's
    'layout.get': (_params, meta) => ctx.layout.get(requireProject(meta).id),
    'layout.set': (params, meta) => {
      const { layout } = z.object({ layout: z.unknown() }).parse(params)
      return ctx.layout.set(requireProject(meta).id, layout as LayoutNode)
    },
    'layout.setActive': (params, meta) => {
      const { tabsId, itemId } = z.object({ tabsId: z.string(), itemId: z.string() }).parse(params)
      ctx.layout.setActive(requireProject(meta).id, tabsId, itemId)
      return { ok: true }
    },
    'layout.setRatios': (params, meta) => {
      const { splitId, ratios } = z
        .object({ splitId: z.string(), ratios: z.array(z.number().positive()) })
        .parse(params)
      ctx.layout.setRatios(requireProject(meta).id, splitId, ratios)
      return { ok: true }
    },
    'layout.openBeside': (params, meta) => {
      const { refItemId, side, block, config, share } = z
        .object({
          refItemId: z.string(),
          side: z.enum(['left', 'right']).default('right'),
          block: z.string(),
          config: z.record(z.string(), z.unknown()).default({}),
          share: z.number().min(0.05).max(0.9).optional()
        })
        .parse(params)
      return ctx.layout.openBeside(
        requireProject(meta).id,
        refItemId,
        { block, config },
        side,
        share
      )
    },
    'layout.updateItem': (params, meta) => {
      const { itemId, config } = z
        .object({ itemId: z.string(), config: z.record(z.string(), z.unknown()) })
        .parse(params)
      return ctx.layout.updateItemConfig(requireProject(meta).id, itemId, config)
    },
    'layout.removeItem': (params, meta) => {
      const { itemId } = z.object({ itemId: z.string() }).parse(params)
      ctx.layout.removeItem(requireProject(meta).id, itemId)
      return { ok: true }
    },

    'block.list': () => [...BUILTIN_BLOCK_INFOS, ...ctx.blocks.list()],
    'block.bundle': (params) => {
      const { name } = z.object({ name: z.string() }).parse(params)
      return ctx.blocks.bundle(name)
    },
    'block.open': (params, meta) => {
      const { name, position } = z
        .object({
          name: z.string(),
          position: z.enum(['tab', 'right', 'down', 'left', 'up']).default('tab')
        })
        .parse(params)
      const project = requireProject(meta)
      if (name === BROWSER_BLOCK) {
        // a browser pane needs a session; the manager's 'created' event adds
        // the layout item synchronously, so it exists by the time we look
        const info = ctx.browsers.create({ projectId: project.id, position })
        const item = findItem(
          ctx.layout.get(project.id),
          (i) => i.block === BROWSER_BLOCK && i.config.browserId === info.id
        )
        if (!item) throw new Error('browser block was not added to the layout')
        return item
      }
      // a file tree reads as a slim rail, not a third of the window
      const share = name === 'files' ? 0.18 : undefined
      if ((BUILTIN_OPENABLE_BLOCKS as readonly string[]).includes(name)) {
        return ctx.layout.addItem(project.id, { block: name, config: {} }, position, true, share)
      }
      ctx.blocks.bundle(name) // throws early if unknown or broken
      // custom blocks live in the layout under their own name, same as builtins
      return ctx.layout.addItem(project.id, { block: name, config: {} }, position, true, share)
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
    },

    // the agent-maintained architecture schema of the caller's project
    // (.airun9/architecture.json); agents edit the file directly
    'architecture.get': (_params, meta) => {
      const project = optionalProject(meta)
      return ctx.architecture.get(project?.id ?? null)
    },

    // cross-agent conversation memory, ingested from the transcript files
    // the agent CLIs (claude, gpt/codex, grok) write on this machine.
    // search is FTS5 keyword match; `project: true` scopes to the open project
    'memory.search': (params, meta) => {
      const { query, agent, cwd, project, limit } = z
        .object({
          query: z.string().min(1),
          agent: z.enum(['claude', 'gpt', 'grok']).optional(),
          cwd: z.string().optional(),
          project: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(20)
        })
        .parse(params)
      return ctx.memory.search({
        query,
        agent,
        cwd: project ? requireProject(meta).path : cwd,
        limit
      })
    },
    'memory.sessions': (params, meta) => {
      const { agent, cwd, project, limit } = z
        .object({
          agent: z.enum(['claude', 'gpt', 'grok']).optional(),
          cwd: z.string().optional(),
          project: z.boolean().default(false),
          limit: z.number().int().min(1).max(200).default(50)
        })
        .parse(params ?? {})
      return ctx.memory.sessions({ agent, cwd: project ? requireProject(meta).path : cwd, limit })
    },
    'memory.messages': (params) => {
      const { sessionId, limit, offset } = z
        .object({
          sessionId: z.string().min(1),
          limit: z.number().int().min(1).max(1000).default(200),
          offset: z.number().int().min(0).default(0)
        })
        .parse(params)
      return ctx.memory.messages(sessionId, limit, offset)
    },
    'memory.stats': () => ctx.memory.stats(),

    // per-block persistence: sandboxed iframes have no localStorage, so
    // blocks keep durable state here, namespaced by block name (the block
    // host injects `block`; blocks themselves pass key/value/scope).
    // Default scope is the caller's project — a notes block follows its
    // project; scope:'global' shares across projects (also the fallback
    // when no project is open, and the legacy pre-multi-project keyspace)
    'storage.get': (params, meta) => {
      const { block, key, scope } = z
        .object({
          block: z.string().min(1),
          key: z.string().min(1),
          scope: z.enum(['project', 'global']).default('project')
        })
        .parse(params)
      return { value: ctx.storage.get(block, storageScope(scope, meta), key) }
    },
    'storage.set': (params, meta) => {
      const { block, key, value, scope } = z
        .object({
          block: z.string().min(1),
          key: z.string().min(1),
          value: z.unknown(),
          scope: z.enum(['project', 'global']).default('project')
        })
        .parse(params)
      ctx.storage.set(block, storageScope(scope, meta), key, value)
      return { ok: true }
    }
  }
}

function findItem(
  node: LayoutNode,
  predicate: (item: LayoutTabItem) => boolean
): LayoutTabItem | null {
  if (node.type === 'tabs') return node.items.find(predicate) ?? null
  for (const child of node.children) {
    const found = findItem(child, predicate)
    if (found) return found
  }
  return null
}

export async function dispatch(
  api: Record<string, Handler>,
  method: string,
  params: unknown,
  meta: CallMeta = {}
): Promise<unknown> {
  const handler = api[method]
  if (!handler) throw new Error(`Unknown method: ${method}`)
  return handler(params, meta)
}
