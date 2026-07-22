import { useState } from 'react'
import type { WorktreeRemoveRequest, WorktreeRequest } from '../../../shared/types'
import { api } from '../lib/api'
import { useWorkspaceStore } from '../stores/workspace'

/**
 * One worktree approval decision (ADR-0011 / ADR-0004). Create shows what
 * appears (branches + the exact base commit); remove shows the blast radius
 * computed at request time — dirty files, unmerged commits, live sessions —
 * plus the "also delete branch" choice. Approving a remove is informed
 * consent for a force removal.
 */
function WorktreeApprovalCard({ request }: { request: WorktreeRequest }): React.JSX.Element {
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const removeWorktreeRequest = useWorkspaceStore((s) => s.removeWorktreeRequest)

  const decide = (approved: boolean): void => {
    setBusy(true)
    void api
      .resolveWorktreeRequest({
        requestId: request.id,
        approved,
        ...(request.kind === 'remove' ? { deleteBranch } : {})
      })
      .catch(console.error)
      .finally(() => {
        removeWorktreeRequest(request.id)
        setBusy(false)
      })
  }

  return (
    <div>
      {request.kind === 'create' ? (
        <div className="rounded-lg bg-white/[0.04] p-3 text-[12px] leading-relaxed text-neutral-300">
          {request.names.map((name, i) => (
            <div key={name} className="flex items-baseline gap-2">
              <span className="text-neutral-100">{name}</span>
              <span className="text-[11px] text-neutral-500">
                branch {request.branches[i]} · from {request.baseLabel}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <RemoveDetails request={request} />
      )}

      {request.reason && (
        <p className="mt-2 text-[11px] leading-snug text-neutral-500">
          Agent&apos;s assessment: {request.reason}
        </p>
      )}

      {request.kind === 'remove' && request.branch && (
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-neutral-300">
          <input
            type="checkbox"
            checked={deleteBranch}
            onChange={(e) => setDeleteBranch(e.target.checked)}
            className="accent-red-500"
          />
          also delete branch {request.branch}
          {request.aheadCommits > 0 && deleteBranch && (
            <span className="text-[11px] text-red-400">
              — its {request.aheadCommits} unmerged commit{request.aheadCommits > 1 ? 's' : ''} die
            </span>
          )}
        </label>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(false)}
          className="rounded-md px-3 py-1.5 text-[12px] text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-200 disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(true)}
          className={`rounded-md px-3 py-1.5 text-[12px] font-medium text-white transition-colors disabled:opacity-50 ${
            request.kind === 'remove'
              ? 'bg-red-600 hover:bg-red-500'
              : 'bg-emerald-600 hover:bg-emerald-500'
          }`}
        >
          {request.kind === 'remove' ? 'Remove' : 'Approve'}
        </button>
      </div>
    </div>
  )
}

function RemoveDetails({ request }: { request: WorktreeRemoveRequest }): React.JSX.Element {
  const risks: string[] = []
  if (request.dirtyFiles > 0) {
    risks.push(`${request.dirtyFiles} uncommitted file${request.dirtyFiles > 1 ? 's' : ''} die`)
  }
  if (request.aheadCommits > 0) {
    risks.push(
      `${request.aheadCommits} commit${request.aheadCommits > 1 ? 's' : ''} not merged into the main checkout`
    )
  }
  const sessions: string[] = []
  if (request.workerCount > 0) {
    sessions.push(`${request.workerCount} worker${request.workerCount > 1 ? 's' : ''}`)
  }
  if (request.terminalCount > 0) {
    sessions.push(`${request.terminalCount} terminal${request.terminalCount > 1 ? 's' : ''}`)
  }
  if (sessions.length > 0) risks.push(`${sessions.join(' and ')} will be stopped`)

  return (
    <div className="rounded-lg bg-white/[0.04] p-3 text-[12px] leading-relaxed">
      <div className="text-neutral-100">
        {request.name}
        {request.external && (
          <span className="ml-2 rounded bg-white/[0.08] px-1 py-px text-[10px] text-neutral-400">
            external
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-neutral-500">{request.path}</div>
      {risks.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {risks.map((risk) => (
            <li key={risk} className="flex items-center gap-1.5 text-[11px] text-amber-300">
              <span aria-hidden>⚠</span> {risk}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 text-[11px] text-neutral-500">
          Clean tree, nothing unmerged, no live sessions.
        </div>
      )}
    </div>
  )
}

export default WorktreeApprovalCard
