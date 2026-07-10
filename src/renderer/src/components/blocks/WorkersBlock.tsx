import { IconPlayerStop, IconX } from '@tabler/icons-react'
import IconAstronaut from '../icons/IconAstronaut'
import type { WorkerInfo } from '../../../../shared/types'
import { api } from '../../lib/api'
import { useWorkspaceStore } from '../../stores/workspace'

const STATUS_STYLE: Record<string, { dot: string; label: string }> = {
  running: { dot: 'bg-emerald-400', label: 'working' },
  done: { dot: 'bg-amber-400', label: 'idle' },
  exited: { dot: 'bg-neutral-600', label: 'exited' }
}

function WorkerRow({ worker }: { worker: WorkerInfo }): React.JSX.Element {
  const status = STATUS_STYLE[worker.status] ?? STATUS_STYLE.exited
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5">
      <span className={`size-2 shrink-0 rounded-full ${status.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] text-neutral-100">{worker.name}</span>
          <span className="text-[11px] text-neutral-500">
            {status.label} · {worker.kind} · {worker.mode}
            {worker.location === 'worktree' ? ' · worktree' : ''}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-neutral-600">{worker.prompt}</div>
      </div>
      {worker.status !== 'exited' && (
        <button
          type="button"
          title="Stop (keep tab)"
          onClick={() => void api.stopWorker(worker.id)}
          className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-white/[0.08] hover:text-amber-300"
        >
          <IconPlayerStop className="size-4" stroke={1.75} />
        </button>
      )}
      <button
        type="button"
        title="Shut down (remove tab)"
        onClick={() => void api.closeWorker(worker.id)}
        className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-white/[0.08] hover:text-red-400"
      >
        <IconX className="size-4" stroke={1.75} />
      </button>
    </div>
  )
}

/** Built-in status board (ADR-0009): every worker, live, with shutdown controls */
function WorkersBlock(): React.JSX.Element {
  const workers = Object.values(useWorkspaceStore((s) => s.workers)).sort(
    (a, b) => b.createdAt - a.createdAt
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <IconAstronaut className="size-4 text-neutral-400" stroke={1.75} />
        <h3 className="text-[11px] tracking-[0.2em] text-neutral-400">WORKERS</h3>
        <span className="text-[11px] text-neutral-600">
          {workers.filter((w) => w.status === 'running').length} working
        </span>
      </div>
      {workers.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-neutral-600">
          No workers yet — ask an agent to spawn some
        </div>
      ) : (
        <div className="space-y-2">
          {workers.map((worker) => (
            <WorkerRow key={worker.id} worker={worker} />
          ))}
        </div>
      )}
    </div>
  )
}

export default WorkersBlock
