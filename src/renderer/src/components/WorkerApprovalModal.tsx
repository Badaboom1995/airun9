import IconOrbit from './icons/IconOrbit'
import ApprovalCard from './ApprovalCard'
import WorktreeApprovalCard from './WorktreeApprovalCard'
import type { WorktreeRequest } from '../../../shared/types'
import { useWorkspaceStore } from '../stores/workspace'

/**
 * The guardrail for mutating agent actions (ADR-0004): `worker request` and
 * `worktree request/remove` block until the user decides here. The agent
 * only recommends; the user makes the call.
 *
 * Only the ACTIVE project's requests pop this modal — a background
 * project's requests surface as a badge on its rail chip instead
 * (approve there or switch; no modal ambush while you type elsewhere).
 */
function WorkerApprovalModal(): React.JSX.Element | null {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const projects = useWorkspaceStore((s) => s.projects)
  const workerRequests = useWorkspaceStore((s) => s.workerRequests)
  const worktreeRequests = useWorkspaceStore((s) => s.worktreeRequests)
  // worktree contexts are child projects of a repo — requests from any
  // context of the repo the user is looking at belong in this modal
  const rootOf = (id: string): string => {
    const project = projects.find((p) => p.id === id)
    return project?.parentId ?? id
  }
  const activeRoot = activeProjectId ? rootOf(activeProjectId) : null
  const workerQueue = workerRequests.filter((r) => rootOf(r.projectId) === activeRoot)
  const worktreeQueue = worktreeRequests.filter((r) => rootOf(r.projectId) === activeRoot)
  const queued = workerQueue.length + worktreeQueue.length

  const workerRequest = workerQueue[0]
  const worktreeRequest = workerRequest ? undefined : worktreeQueue[0]
  if (!workerRequest && !worktreeRequest) return null

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className="w-[480px] rounded-xl border border-white/10 bg-[#131614] p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <IconOrbit className="size-4 text-emerald-400" stroke={1.75} spinning />
          <h2 className="text-[13px] font-medium text-neutral-100">
            {workerRequest
              ? `An agent wants to spawn ${
                  workerRequest.count > 1 ? `${workerRequest.count} workers` : 'a worker'
                }`
              : worktreeTitle(worktreeRequest!)}
          </h2>
        </div>

        <div className="mt-3">
          {/* keyed so pickers reset between requests */}
          {workerRequest ? (
            <ApprovalCard key={workerRequest.id} request={workerRequest} />
          ) : (
            <WorktreeApprovalCard key={worktreeRequest!.id} request={worktreeRequest!} />
          )}
        </div>

        {queued > 1 && (
          <p className="mt-3 text-right text-[11px] text-neutral-600">
            +{queued - 1} more request{queued > 2 ? 's' : ''} waiting
          </p>
        )}
      </div>
    </div>
  )
}

function worktreeTitle(request: WorktreeRequest): string {
  if (request.kind === 'create') {
    return request.names.length > 1
      ? `An agent wants ${request.names.length} worktrees`
      : 'An agent wants a worktree'
  }
  return `Remove worktree ${request.name}?`
}

export default WorkerApprovalModal
