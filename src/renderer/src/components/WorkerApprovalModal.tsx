import IconOrbit from './icons/IconOrbit'
import ApprovalCard from './ApprovalCard'
import { useWorkspaceStore } from '../stores/workspace'

/**
 * The guardrail for mutating workers (ADR-0004): an agent's
 * `worker request` blocks until the user decides here. The agent only
 * recommends; the user picks the final mode and location.
 *
 * Only the ACTIVE project's requests pop this modal — a background
 * project's requests surface as a badge on its rail chip instead
 * (approve there or switch; no modal ambush while you type elsewhere).
 */
function WorkerApprovalModal(): React.JSX.Element | null {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const requests = useWorkspaceStore((s) => s.workerRequests)
  const queue = requests.filter((r) => r.projectId === activeProjectId)

  const request = queue[0]
  if (!request) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className="w-[480px] rounded-xl border border-white/10 bg-[#131614] p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <IconOrbit className="size-4 text-emerald-400" stroke={1.75} spinning />
          <h2 className="text-[13px] font-medium text-neutral-100">
            An agent wants to spawn {request.count > 1 ? `${request.count} workers` : 'a worker'}
          </h2>
        </div>

        <div className="mt-3">
          {/* keyed so pickers reset between requests */}
          <ApprovalCard key={request.id} request={request} />
        </div>

        {queue.length > 1 && (
          <p className="mt-3 text-right text-[11px] text-neutral-600">
            +{queue.length - 1} more request{queue.length > 2 ? 's' : ''} waiting
          </p>
        )}
      </div>
    </div>
  )
}

export default WorkerApprovalModal
