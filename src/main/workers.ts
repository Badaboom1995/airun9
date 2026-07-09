import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type {
  ProjectInfo,
  WorkerInfo,
  WorkerLocation,
  WorkerMode,
  WorkerRequest,
  WorkerRequestDecision
} from '../shared/types'
import type { TerminalManager } from './terminals'
import { ensureClaudeSettings, type ClaudeSettingsPaths } from './claude-settings'

const execFileAsync = promisify(execFile)

/** ADR-0008: worker.spawn ships with a concurrency cap (on actively working) */
const MAX_RUNNING_WORKERS = 4
const WORKTREES_DIR = join(homedir(), '.airun9', 'worktrees')

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
    private terminals: TerminalManager,
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
      }
    })
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
          cwd: project.path
        })
      )
    )
  }

  /**
   * Full-worker door: parks a request and resolves only when the user
   * decides in the app. There is deliberately no API path that spawns a
   * mutating worker without this.
   */
  requestFull(options: FullRequestOptions): Promise<WorkerInfo[]> {
    const request: WorkerRequest = {
      id: `req_${nanoid(8)}`,
      prompt: options.prompt,
      name: options.name ?? null,
      count: options.count ?? 1,
      reason: options.reason ?? null,
      recommendedMode: options.recommendedMode,
      recommendedLocation: options.recommendedLocation,
      createdAt: Date.now()
    }
    return new Promise<WorkerInfo[]>((resolve, reject) => {
      this.pending.set(request.id, { request, resolve, reject })
      this.emit('request', request)
    })
  }

  pendingRequests(): WorkerRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  async resolveRequest(decision: WorkerRequestDecision, project: ProjectInfo): Promise<void> {
    const pending = this.pending.get(decision.requestId)
    if (!pending) throw new Error(`Unknown worker request: ${decision.requestId}`)
    this.pending.delete(decision.requestId)
    this.emit('request-resolved', { requestId: decision.requestId, approved: decision.approved })

    if (!decision.approved) {
      pending.reject(new Error('Worker request denied by the user'))
      return
    }

    const { request } = pending
    try {
      const workers = await Promise.all(
        Array.from({ length: request.count }, async (_, i) => {
          const name = indexedName(request.name ?? 'worker', request.count, i)
          const cwd =
            decision.location === 'worktree'
              ? await this.createWorktree(project, name)
              : project.path
          return this.spawn({
            prompt: request.prompt,
            name,
            kind: 'full',
            mode: decision.mode,
            location: decision.location,
            cwd
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

  list(): WorkerInfo[] {
    return [...this.workers.values()]
  }

  get(id: string): WorkerInfo {
    const worker = this.workers.get(id)
    if (!worker) throw new Error(`Unknown worker: ${id}`)
    return worker
  }

  read(id: string, tailChars?: number): { data: string; seq: number } {
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
    return worker
  }

  private async spawn(options: {
    prompt: string
    name: string
    kind: 'scout' | 'full'
    mode: WorkerMode
    location: WorkerLocation
    cwd: string
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

    const terminal = this.terminals.create({
      cwd: options.cwd,
      title: options.name,
      command,
      workerId: id,
      env: { AIRUN9_WORKER_ID: id }
    })

    const worker: WorkerInfo = {
      id,
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
    return worker
  }

  private async createWorktree(project: ProjectInfo, workerName: string): Promise<string> {
    mkdirSync(WORKTREES_DIR, { recursive: true })
    const slug = `${project.name}-${workerName}-${nanoid(6)}`.replace(/[^\w.-]/g, '-')
    const dir = join(WORKTREES_DIR, slug)
    const branch = `airun9/${slug}`
    await execFileAsync('git', ['-C', project.path, 'worktree', 'add', dir, '-b', branch])
    return dir
  }
}

function indexedName(base: string, count: number, index: number): string {
  return count > 1 ? `${base}-${index + 1}` : base
}
