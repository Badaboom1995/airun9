import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { nanoid } from 'nanoid'
import type {
  ProjectInfo,
  WorkerInfo,
  WorkerLocation,
  WorkerMode,
  WorkerRequest,
  WorkerRequestDecision
} from '../shared/types'
import type { TerminalClient } from './terminals'
import type { WorktreeManager } from './worktrees'
import { ensureClaudeSettings, type ClaudeSettingsPaths } from './claude-settings'
import { loadWorkers, saveWorkers } from './worker-store'

/** ADR-0008: worker.spawn ships with a concurrency cap (on actively working) */
const MAX_RUNNING_WORKERS = 4

const MODE_FLAGS: Record<WorkerMode, string> = {
  plan: '--permission-mode plan',
  bypass: '--permission-mode bypassPermissions',
  edits: '--permission-mode acceptEdits',
  manual: ''
}

export interface ScoutOptions {
  prompt: string
  name?: string
  count?: number
}

export interface FullRequestOptions {
  prompt: string
  name?: string
  count?: number
  reason?: string
  recommendedMode: Exclude<WorkerMode, 'plan'>
  recommendedLocation: WorkerLocation
}

interface PendingRequest {
  request: WorkerRequest
  /** Captured at request time — approval spawns into THIS project even if
   * the user is looking at another one when they decide */
  project: ProjectInfo
  resolve: (workers: WorkerInfo[]) => void
  reject: (error: Error) => void
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * A Worker is one isolated agent doing a task (ADR-0002): an interactive
 * claude session in a managed terminal, with lifecycle reported back through
 * injected hooks. Two kinds:
 * - scout: read-only (plan mode + deny rules), spawns without approval
 * - full: mutating; spawning requires the user's in-app approval, where the
 *   user picks the permission mode and shared-dir vs worktree (ADR-0004)
 */
export class WorkerManager extends EventEmitter {
  private workers = new Map<string, WorkerInfo>()
  private pending = new Map<string, PendingRequest>()
  private settings: ClaudeSettingsPaths

  constructor(
    private terminals: TerminalClient,
    private worktrees: WorktreeManager,
    binDir: string
  ) {
    super()
    this.settings = ensureClaudeSettings(binDir)
    terminals.on('exit', ({ id, exitCode }) => {
      const worker = [...this.workers.values()].find((w) => w.terminalId === id)
      if (worker && worker.status !== 'exited') {
        worker.status = 'exited'
        worker.exitCode = exitCode
        this.emit('updated', worker)
        this.persist()
      }
    })
  }

  /**
   * Load the previous run's workers and reconcile with the daemon's live
   * sessions (docs/plans/pty-daemon.md phase 3). Call after the terminal
   * client has connected and seeded. Terminal alive → worker returns with
   * its persisted status (a stop hook that fired while the IDE was closed
   * is lost — accepted v1 gap; the next lifecycle event corrects it).
   * Terminal exited → worker exited. Terminal gone (reboot, daemon crash,
   * closed tab) → record dropped, which is also what prunes the store.
   */
  rehydrate(): void {
    const live = new Map(this.terminals.list().map((t) => [t.id, t]))
    for (const worker of loadWorkers()) {
      if (this.workers.has(worker.id)) continue
      const terminal = live.get(worker.terminalId)
      if (!terminal) continue
      if (terminal.status !== 'running' && worker.status !== 'exited') {
        worker.status = 'exited'
        worker.exitCode = terminal.exitCode
      }
      this.workers.set(worker.id, worker)
    }
    this.persist()
  }

  private persist(): void {
    saveWorkers(this.workers.values())
  }

  async createScouts(options: ScoutOptions, project: ProjectInfo): Promise<WorkerInfo[]> {
    const count = options.count ?? 1
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        this.spawn({
          prompt: options.prompt,
          name: indexedName(options.name ?? 'scout', count, i),
          kind: 'scout',
          mode: 'plan',
          location: 'shared',
          cwd: project.path,
          projectId: project.id
        })
      )
    )
  }

  /**
   * Full-worker door: parks a request and resolves only when the user
   * decides in the app. There is deliberately no API path that spawns a
   * mutating worker without this.
   */
  requestFull(options: FullRequestOptions, project: ProjectInfo): Promise<WorkerInfo[]> {
    const request: WorkerRequest = {
      id: `req_${nanoid(8)}`,
      projectId: project.id,
      prompt: options.prompt,
      name: options.name ?? null,
      count: options.count ?? 1,
      reason: options.reason ?? null,
      recommendedMode: options.recommendedMode,
      recommendedLocation: options.recommendedLocation,
      createdAt: Date.now()
    }
    return new Promise<WorkerInfo[]>((resolve, reject) => {
      this.pending.set(request.id, { request, project, resolve, reject })
      this.emit('request', request)
    })
  }

  pendingRequests(): WorkerRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  async resolveRequest(decision: WorkerRequestDecision): Promise<void> {
    const pending = this.pending.get(decision.requestId)
    if (!pending) throw new Error(`Unknown worker request: ${decision.requestId}`)
    this.pending.delete(decision.requestId)
    this.emit('request-resolved', { requestId: decision.requestId, approved: decision.approved })

    if (!decision.approved) {
      pending.reject(new Error('Worker request denied by the user'))
      return
    }

    const { request, project } = pending
    try {
      // spawn-into-existing shares one worktree between all N workers
      // (ADR-0011 allows it — the user chose it on the card)
      const existingPath = decision.worktreeId
        ? (await this.worktrees.find(project, decision.worktreeId)).path
        : null
      const workers = await Promise.all(
        Array.from({ length: request.count }, async (_, i) => {
          const name = indexedName(request.name ?? 'worker', request.count, i)
          const cwd =
            decision.location === 'worktree'
              ? (existingPath ?? (await this.worktrees.createForWorker(project, name)))
              : project.path
          return this.spawn({
            prompt: request.prompt,
            name,
            kind: 'full',
            mode: decision.mode,
            location: decision.location,
            cwd,
            projectId: project.id
          })
        })
      )
      pending.resolve(workers)
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /** Lifecycle reports from the hooks injected via --settings */
  hookEvent(workerId: string, event: string, transcriptPath?: string): void {
    const worker = this.workers.get(workerId)
    if (!worker || worker.status === 'exited') return
    if (transcriptPath) worker.transcriptPath = transcriptPath
    if (event === 'stop') worker.status = 'done'
    else if (event === 'prompt-submit') worker.status = 'running'
    this.emit('updated', worker)
    this.persist()
  }

  /**
   * Resolves when every listed worker has left `running` (done or exited).
   * Event-driven — this is what lets agents wait via a background shell
   * task instead of polling `worker list`.
   */
  wait(ids: string[]): Promise<WorkerInfo[]> {
    const pending = new Set(ids.filter((id) => this.get(id).status === 'running'))
    if (pending.size === 0) return Promise.resolve(ids.map((id) => this.get(id)))
    return new Promise((resolve) => {
      const onUpdated = (worker: WorkerInfo): void => {
        if (worker.status !== 'running') pending.delete(worker.id)
        if (pending.size === 0) {
          this.off('updated', onUpdated)
          resolve(ids.map((id) => this.get(id)))
        }
      }
      this.on('updated', onUpdated)
    })
  }

  /** Continue an idle worker's session (keep-alive follow-ups) */
  prompt(id: string, text: string): WorkerInfo {
    const worker = this.get(id)
    if (worker.status !== 'done') {
      throw new Error(
        `Worker is ${worker.status}; follow-up prompts are only allowed when it is done (idle)`
      )
    }
    this.terminals.write(worker.terminalId, text.replace(/\r?\n/g, ' ') + '\r')
    worker.status = 'running'
    this.emit('updated', worker)
    this.persist()
    return worker
  }

  /** Final answer of the last finished turn, parsed from the transcript */
  result(id: string): { status: string; text: string | null; transcriptPath: string | null } {
    const worker = this.get(id)
    if (!worker.transcriptPath) {
      return { status: worker.status, text: null, transcriptPath: null }
    }
    let text: string | null = null
    try {
      const lines = readFileSync(worker.transcriptPath, 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as {
            type?: string
            message?: { content?: Array<{ type?: string; text?: string }> }
          }
          if (entry.type !== 'assistant') continue
          const parts = (entry.message?.content ?? [])
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text)
          if (parts.length > 0) text = parts.join('\n')
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      throw new Error(`Cannot read worker transcript: ${worker.transcriptPath}`)
    }
    return { status: worker.status, text, transcriptPath: worker.transcriptPath }
  }

  list(projectId?: string): WorkerInfo[] {
    const all = [...this.workers.values()]
    return projectId ? all.filter((w) => w.projectId === projectId) : all
  }

  /** Project is closing: reject its pending approvals, stop its workers */
  closeProject(projectId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.projectId !== projectId) continue
      this.pending.delete(id)
      this.emit('request-resolved', { requestId: id, approved: false })
      pending.reject(new Error('Project was closed before the request was decided'))
    }
    for (const worker of this.workers.values()) {
      if (worker.projectId === projectId && worker.status !== 'exited') {
        this.terminals.kill(worker.terminalId)
      }
    }
  }

  get(id: string): WorkerInfo {
    const worker = this.workers.get(id)
    if (!worker) throw new Error(`Unknown worker: ${id}`)
    return worker
  }

  read(id: string, tailChars?: number): Promise<{ data: string; seq: number }> {
    return this.terminals.read(this.get(id).terminalId, tailChars)
  }

  stop(id: string): WorkerInfo {
    const worker = this.get(id)
    if (worker.status !== 'exited') this.terminals.kill(worker.terminalId)
    return worker
  }

  /** Stop the worker AND remove its terminal tab from the workspace */
  close(id: string): WorkerInfo {
    const worker = this.get(id)
    try {
      this.terminals.close(worker.terminalId)
    } catch {
      // terminal already gone; still mark the worker exited below
    }
    if (worker.status !== 'exited') {
      worker.status = 'exited'
      this.emit('updated', worker)
    }
    this.persist()
    return worker
  }

  private async spawn(options: {
    prompt: string
    name: string
    kind: 'scout' | 'full'
    mode: WorkerMode
    location: WorkerLocation
    cwd: string
    projectId: string
  }): Promise<WorkerInfo> {
    const running = [...this.workers.values()].filter((w) => w.status === 'running')
    if (running.length >= MAX_RUNNING_WORKERS) {
      throw new Error(
        `Worker concurrency cap reached (${MAX_RUNNING_WORKERS} running). Stop a worker first.`
      )
    }

    const id = `worker_${nanoid(10)}`
    const settingsPath = options.kind === 'scout' ? this.settings.scout : this.settings.worker
    const command = [
      'claude',
      MODE_FLAGS[options.mode],
      `--settings ${shellQuote(settingsPath)}`,
      shellQuote(options.prompt)
    ]
      .filter(Boolean)
      .join(' ')

    const terminal = await this.terminals.create({
      projectId: options.projectId,
      cwd: options.cwd,
      title: options.name,
      command,
      workerId: id,
      env: { AIRUN9_WORKER_ID: id }
    })

    const worker: WorkerInfo = {
      id,
      projectId: options.projectId,
      name: options.name,
      prompt: options.prompt,
      terminalId: terminal.id,
      kind: options.kind,
      mode: options.mode,
      location: options.location,
      cwd: options.cwd,
      status: 'running',
      exitCode: null,
      transcriptPath: null,
      createdAt: Date.now()
    }
    this.workers.set(id, worker)
    this.emit('created', worker)
    this.persist()
    return worker
  }
}

function indexedName(base: string, count: number, index: number): string {
  return count > 1 ? `${base}-${index + 1}` : base
}
