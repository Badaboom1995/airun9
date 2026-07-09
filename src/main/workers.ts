import { EventEmitter } from 'node:events'
import { nanoid } from 'nanoid'
import type { WorkerInfo } from '../shared/types'
import type { TerminalManager } from './terminals'

/** ADR-0008: worker.spawn ships with a concurrency cap */
const MAX_RUNNING_WORKERS = 4

export interface CreateWorkerOptions {
  prompt: string
  name?: string
  cwd: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * A Worker is one isolated agent doing a task (ADR-0002). v1-slice: a
 * terminal running `claude` with a prompt, in the Project directory.
 * Worktree isolation comes next.
 */
export class WorkerManager extends EventEmitter {
  private workers = new Map<string, WorkerInfo>()

  constructor(private terminals: TerminalManager) {
    super()
    terminals.on('exit', ({ id, exitCode }) => {
      const worker = [...this.workers.values()].find((w) => w.terminalId === id)
      if (worker && worker.status === 'running') {
        worker.status = 'exited'
        worker.exitCode = exitCode
        this.emit('updated', worker)
      }
    })
  }

  create(options: CreateWorkerOptions): WorkerInfo {
    const running = [...this.workers.values()].filter((w) => w.status === 'running')
    if (running.length >= MAX_RUNNING_WORKERS) {
      throw new Error(
        `Worker concurrency cap reached (${MAX_RUNNING_WORKERS} running). Stop a worker first.`
      )
    }

    const id = `worker_${nanoid(10)}`
    const name = options.name ?? `worker-${this.workers.size + 1}`

    const terminal = this.terminals.create({
      cwd: options.cwd,
      title: name,
      command: `claude ${shellQuote(options.prompt)}`,
      workerId: id
    })

    const worker: WorkerInfo = {
      id,
      name,
      prompt: options.prompt,
      terminalId: terminal.id,
      status: 'running',
      exitCode: null,
      createdAt: Date.now()
    }
    this.workers.set(id, worker)
    this.emit('created', worker)
    return worker
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
    if (worker.status === 'running') this.terminals.kill(worker.terminalId)
    return worker
  }
}
