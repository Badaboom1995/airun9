import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { nanoid } from 'nanoid'
import type {
  ProjectInfo,
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeInfo,
  WorktreeRemoveRequest,
  WorktreeRequest,
  WorktreeRequestDecision
} from '../shared/types'
import type { TerminalManager } from './terminals'
import type { WorkerManager } from './workers'
import type { ProjectManager } from './projects'
import type { BlockStorage } from './storage'

const execFileAsync = promisify(execFile)

export const WORKTREES_DIR = join(homedir(), '.airun9', 'worktrees')

/** Storage namespace for the per-project bootstrap command */
const STORAGE_BLOCK = 'worktree'

/** Valid worktree/branch name: filesystem- and git-ref-safe */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/

interface PendingWorktreeRequest {
  request: WorktreeRequest
  /** Captured at request time — the decision executes against THIS project
   * even if the user is looking at another one */
  project: ProjectInfo
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

/**
 * Worktrees are first-class resources (ADR-0011): a project has many, the
 * main checkout is the default one, workers and manual terminals live inside
 * them. Git is the source of truth — list() parses `git worktree list`
 * fresh every time; nothing here is persisted except the per-project
 * bootstrap command.
 *
 * Both mutations are gated (ADR-0004): agents request, the user decides in
 * the app. The UI's create dialog IS consent, so the ipc door may create
 * directly; removal always goes through the approval card, whoever asks.
 */
export class WorktreeManager extends EventEmitter {
  private pending = new Map<string, PendingWorktreeRequest>()
  /** Set after construction (WorkerManager needs us first) */
  private workers: WorkerManager | null = null

  constructor(
    private terminals: TerminalManager,
    private storage: BlockStorage,
    private projects: ProjectManager
  ) {
    super()
  }

  bindWorkers(workers: WorkerManager): void {
    this.workers = workers
  }

  /** Fresh scan: prune stale registrations, parse the porcelain list.
   * A non-repo project simply has no worktrees. */
  async list(project: ProjectInfo): Promise<WorktreeInfo[]> {
    let stdout: string
    try {
      await this.git(project.path, ['worktree', 'prune'])
      stdout = (await this.git(project.path, ['worktree', 'list', '--porcelain'])).stdout
    } catch {
      return []
    }
    const infos: WorktreeInfo[] = []
    for (const block of stdout.split('\n\n')) {
      const lines = block.split('\n').filter(Boolean)
      const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
      if (!path) continue
      const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? ''
      const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length)
      // git lists the main working tree first — robust even when this
      // project IS a worktree context (child workspace) of the repo
      const isMain = infos.length === 0
      infos.push({
        id: worktreeId(path),
        projectId: project.id,
        name: basename(path),
        path,
        branch: ref ? ref.replace(/^refs\/heads\//, '') : null,
        head: head.slice(0, 7),
        isMain,
        external: !isMain && !path.startsWith(WORKTREES_DIR + sep)
      })
    }
    // main checkout first, then by name
    return infos.sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name))
  }

  /** Find by id or name; throws if the project has no such worktree */
  async find(project: ProjectInfo, idOrName: string): Promise<WorktreeInfo> {
    const infos = await this.list(project)
    const found = infos.find((w) => w.id === idOrName || w.name === idOrName)
    if (!found) throw new Error(`Unknown worktree: ${idOrName}`)
    return found
  }

  /**
   * Switch the user's context to a worktree (ADR-0011). Every worktree is a
   * child workspace of its repo project — own layout tree, own terminals,
   * own file root — so activating one switches every block at once. The main
   * checkout is simply the repo project itself.
   */
  async activate(idOrName: string, project: ProjectInfo): Promise<ProjectInfo> {
    const worktree = await this.find(project, idOrName)
    const owner = this.owner(project)
    if (worktree.path === owner.path) return this.projects.activate(owner.id)
    return this.projects.open(worktree.path, owner.id)
  }

  /**
   * Agent door: park a create request and resolve only when the user decides
   * (ADR-0004: worktree ops are git.write → prompt). N worktrees = one card.
   */
  async requestCreate(
    options: { name: string; count: number; from?: string; reason?: string },
    project: ProjectInfo
  ): Promise<WorktreeCreateResult> {
    const names = Array.from({ length: options.count }, (_, i) =>
      options.count > 1 ? `${options.name}-${i + 1}` : options.name
    )
    for (const name of names) this.validateName(name)
    await this.ensureUnused(project, names)
    const { base, baseLabel } = await this.resolveBase(project, options.from)

    const request: WorktreeCreateRequest = {
      kind: 'create',
      id: `wtreq_${nanoid(8)}`,
      projectId: project.id,
      names,
      branches: names.map((name) => `airun9/${name}`),
      base,
      baseLabel,
      reason: options.reason ?? null,
      createdAt: Date.now()
    }
    return this.park(request, project) as Promise<WorktreeCreateResult>
  }

  /**
   * Removal request — the only path to removal, for every caller (the UI ✕
   * also lands here: destructive ops confirm regardless of who asks). The
   * blast radius is computed now so the card shows what approval destroys.
   */
  async requestRemove(
    options: { idOrName: string; reason?: string },
    project: ProjectInfo
  ): Promise<{ removed: boolean; branchDeleted: boolean }> {
    const worktree = await this.find(project, options.idOrName)
    if (worktree.isMain) throw new Error('The main checkout cannot be removed')

    const request: WorktreeRemoveRequest = {
      kind: 'remove',
      id: `wtreq_${nanoid(8)}`,
      projectId: project.id,
      worktreeId: worktree.id,
      name: worktree.name,
      path: worktree.path,
      branch: worktree.branch,
      external: worktree.external,
      dirtyFiles: await this.dirtyCount(worktree.path),
      aheadCommits: await this.aheadCount(project, worktree),
      workerCount: this.liveWorkers(worktree.path).length,
      terminalCount: this.liveTerminals(worktree.path).length,
      reason: options.reason ?? null,
      createdAt: Date.now()
    }
    return this.park(request, project) as Promise<{ removed: boolean; branchDeleted: boolean }>
  }

  pendingRequests(): WorktreeRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  async resolveRequest(decision: WorktreeRequestDecision): Promise<void> {
    const pending = this.pending.get(decision.requestId)
    if (!pending) throw new Error(`Unknown worktree request: ${decision.requestId}`)
    this.pending.delete(decision.requestId)
    this.emit('request-resolved', { requestId: decision.requestId, approved: decision.approved })

    if (!decision.approved) {
      pending.reject(new Error('Worktree request denied by the user'))
      return
    }
    try {
      const { request, project } = pending
      if (request.kind === 'create') {
        const worktrees: WorktreeInfo[] = []
        for (const name of request.names) {
          worktrees.push(await this.createWorktree(project, name, request.base))
        }
        pending.resolve({
          worktrees,
          bootstrapCmd: this.bootstrapCmd(project.id)
        } satisfies WorktreeCreateResult)
      } else {
        const branchDeleted = await this.executeRemove(project, request, decision)
        pending.resolve({ removed: true, branchDeleted })
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /** UI door: the create dialog is the user's consent — no second gate.
   * A given bootstrapCmd becomes the project's remembered default. */
  async create(
    options: { name: string; from?: string; bootstrapCmd?: string },
    project: ProjectInfo
  ): Promise<WorktreeCreateResult> {
    this.validateName(options.name)
    await this.ensureUnused(project, [options.name])
    const { base } = await this.resolveBase(project, options.from)
    if (typeof options.bootstrapCmd === 'string') {
      this.setBootstrapCmd(project.id, options.bootstrapCmd)
    }
    const worktree = await this.createWorktree(project, options.name, base)
    return { worktrees: [worktree], bootstrapCmd: this.bootstrapCmd(project.id) }
  }

  /**
   * Worker door: an approved full-worker spawn already carries the user's
   * consent, so no second card. Name collisions get a random suffix — worker
   * names repeat across requests ("worker", "worker-2", ...).
   */
  async createForWorker(project: ProjectInfo, workerName: string): Promise<string> {
    let name = workerName.replace(/[^\w.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'worker'
    name = name.slice(0, 50)
    try {
      await this.ensureUnused(project, [name])
    } catch {
      name = `${name}-${nanoid(4)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}`
    }
    const { base } = await this.resolveBase(project, undefined)
    const worktree = await this.createWorktree(project, name, base)
    return worktree.path
  }

  bootstrapCmd(projectId: string): string | null {
    const value = this.storage.get(STORAGE_BLOCK, projectId, 'bootstrapCmd')
    return typeof value === 'string' && value.trim() ? value : null
  }

  setBootstrapCmd(projectId: string, cmd: string): void {
    this.storage.set(STORAGE_BLOCK, projectId, 'bootstrapCmd', cmd.trim() || null)
  }

  /** Project is closing: its pending approvals die with it */
  closeProject(projectId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.projectId !== projectId) continue
      this.pending.delete(id)
      this.emit('request-resolved', { requestId: id, approved: false })
      pending.reject(new Error('Project was closed before the request was decided'))
    }
  }

  private park(request: WorktreeRequest, project: ProjectInfo): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { request, project, resolve, reject })
      this.emit('request', request)
    })
  }

  private async createWorktree(
    project: ProjectInfo,
    name: string,
    base: string
  ): Promise<WorktreeInfo> {
    // dirs are keyed by the repo project even when a child context creates
    const key = projectKey(this.owner(project))
    const dir = join(WORKTREES_DIR, key, name)
    mkdirSync(join(WORKTREES_DIR, key), { recursive: true })
    await this.git(project.path, ['worktree', 'add', dir, '-b', `airun9/${name}`, base])
    this.copyEnvFiles(project.path, dir)
    this.emit('changed', { projectId: project.id })
    return {
      id: worktreeId(dir),
      projectId: project.id,
      name,
      path: dir,
      branch: `airun9/${name}`,
      head: base.slice(0, 7),
      isMain: false,
      external: false
    }
  }

  private async executeRemove(
    project: ProjectInfo,
    request: WorktreeRemoveRequest,
    decision: WorktreeRequestDecision
  ): Promise<boolean> {
    // the worktree's child workspace dies first (kills its sessions via the
    // project-closed wiring); land the user back on the repo project
    const child = this.projects.list().find((p) => p.path === request.path)
    if (child) {
      if (this.projects.active()?.id === child.id) {
        const owner = this.projects.list().find((p) => p.id === child.parentId)
        if (owner) this.projects.activate(owner.id)
      }
      this.projects.close(child.id)
    }
    // then any remaining sessions — their cwd is about to vanish
    for (const worker of this.liveWorkers(request.path)) {
      try {
        this.workers?.close(worker.id)
      } catch {
        // already gone
      }
    }
    for (const terminal of this.liveTerminals(request.path)) {
      try {
        this.terminals.close(terminal.id)
      } catch {
        // already gone
      }
    }
    // force: the card showed the dirty state; approval is informed consent
    await this.git(project.path, ['worktree', 'remove', '--force', request.path])
    let branchDeleted = false
    if (decision.deleteBranch && request.branch) {
      await this.git(project.path, ['branch', '-D', request.branch])
      branchDeleted = true
    }
    this.emit('changed', { projectId: project.id })
    return branchDeleted
  }

  /** git can't restore ignored config; a few root-level .env files can be
   * copied deterministically so the tree isn't dead on arrival */
  private copyEnvFiles(from: string, to: string): void {
    try {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith('.env')) {
          copyFileSync(join(from, entry.name), join(to, entry.name))
        }
      }
    } catch (error) {
      console.error('worktree .env copy failed:', error)
    }
  }

  /** Resolve the base to a fixed commit NOW — the approval card shows exactly
   * what will be used, even if HEAD moves before the user decides */
  private async resolveBase(
    project: ProjectInfo,
    from: string | undefined
  ): Promise<{ base: string; baseLabel: string }> {
    const ref = from ?? 'HEAD'
    const sha = (
      await this.git(project.path, ['rev-parse', '--short', `${ref}^{commit}`])
    ).stdout.trim()
    const refName = from
      ? from
      : (await this.git(project.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    return { base: sha, baseLabel: `${refName === 'HEAD' ? 'detached' : refName} @ ${sha}` }
  }

  private validateName(name: string): void {
    if (!NAME_PATTERN.test(name) || name.includes('..')) {
      throw new Error(
        `Invalid worktree name "${name}" — use letters, digits, dots, dashes (max 60 chars)`
      )
    }
  }

  private async ensureUnused(project: ProjectInfo, names: string[]): Promise<void> {
    const existing = await this.list(project)
    for (const name of names) {
      if (existing.some((w) => w.name === name)) {
        throw new Error(`A worktree named "${name}" already exists`)
      }
      const branchProbe = await this.git(project.path, ['branch', '--list', `airun9/${name}`])
      if (branchProbe.stdout.trim()) {
        throw new Error(`Branch airun9/${name} already exists — pick another name`)
      }
    }
  }

  private async dirtyCount(worktreePath: string): Promise<number> {
    try {
      const { stdout } = await this.git(worktreePath, ['status', '--porcelain'])
      return stdout.split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  /** Commits on the worktree's branch the main checkout's HEAD doesn't have */
  private async aheadCount(project: ProjectInfo, worktree: WorktreeInfo): Promise<number> {
    if (!worktree.branch) return 0
    try {
      const { stdout } = await this.git(project.path, [
        'rev-list',
        '--count',
        `HEAD..${worktree.branch}`
      ])
      return Number(stdout.trim()) || 0
    } catch {
      return 0
    }
  }

  /** By cwd, across all projects — a worktree's sessions may belong to the
   * repo project (workers) or to its child workspace (context terminals) */
  private liveWorkers(path: string): { id: string }[] {
    return (this.workers?.list() ?? []).filter((w) => w.status !== 'exited' && inside(w.cwd, path))
  }

  private liveTerminals(path: string): { id: string }[] {
    return this.terminals
      .list()
      .filter((t) => t.status === 'running' && !t.workerId && inside(t.cwd, path))
  }

  /** The repo project that owns the worktree set (a child context defers
   * to its parent) */
  private owner(project: ProjectInfo): ProjectInfo {
    if (!project.parentId) return project
    try {
      return this.projects.get(project.parentId)
    } catch {
      return project
    }
  }

  private git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', ['-C', cwd, ...args])
  }
}

/** Deterministic id from the path — rescans keep ids stable */
export function worktreeId(path: string): string {
  return `wt_${createHash('sha1').update(path).digest('hex').slice(0, 10)}`
}

/** Per-project folder: readable name + id fragment so two repos with the
 * same basename never share a folder */
function projectKey(project: ProjectInfo): string {
  return `${project.name.replace(/[^\w.-]/g, '-')}-${project.id.slice(5, 11)}`
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep)
}
