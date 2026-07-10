import { useEffect, useState } from 'react'
import IconAstronaut from './icons/IconAstronaut'
import type { WorkerLocation, WorkerMode, WorkerRequest } from '../../../shared/types'
import { api, events } from '../lib/api'

type FullMode = Exclude<WorkerMode, 'plan'>

const MODES: { value: FullMode; label: string; hint: string }[] = [
  { value: 'bypass', label: 'Auto', hint: 'never asks permission — fully unattended' },
  { value: 'edits', label: 'Allow edits', hint: 'file edits auto-approved, shell commands ask' },
  { value: 'manual', label: 'Manual', hint: 'every permission asks in the worker tab' }
]

const LOCATIONS: { value: WorkerLocation; label: string; hint: string }[] = [
  { value: 'worktree', label: 'Worktree', hint: 'isolated copy + branch; merge later' },
  { value: 'shared', label: 'Project dir', hint: 'works directly in your checkout' }
]

function OptionRow<T extends string>(props: {
  options: { value: T; label: string; hint: string }[]
  value: T
  recommended: T
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="flex gap-2">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => props.onChange(option.value)}
          className={`flex-1 rounded-lg border p-2.5 text-left transition-colors ${
            props.value === option.value
              ? 'border-emerald-500/60 bg-emerald-500/10'
              : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'
          }`}
        >
          <div className="flex items-center gap-1.5 text-[12px] text-neutral-100">
            {option.label}
            {props.recommended === option.value && (
              <span className="rounded bg-emerald-500/20 px-1 py-px text-[10px] text-emerald-300">
                recommended
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-neutral-500">{option.hint}</div>
        </button>
      ))}
    </div>
  )
}

/**
 * The guardrail for mutating workers (ADR-0004): an agent's
 * `worker request` blocks until the user decides here. The agent only
 * recommends; the user picks the final mode and location.
 */
function WorkerApprovalModal(): React.JSX.Element | null {
  const [queue, setQueue] = useState<WorkerRequest[]>([])
  const [mode, setMode] = useState<FullMode | null>(null)
  const [location, setLocation] = useState<WorkerLocation | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const offRequest = events.onWorkerRequest((request) =>
      setQueue((q) => (q.some((r) => r.id === request.id) ? q : [...q, request]))
    )
    // handle resolutions from elsewhere (another window, app restart race)
    const offResolved = events.onWorkerRequestResolved(({ requestId }) =>
      setQueue((q) => q.filter((r) => r.id !== requestId))
    )
    void api.pendingWorkerRequests().then((pending) =>
      setQueue((q) => {
        const known = new Set(q.map((r) => r.id))
        return [...q, ...pending.filter((r) => !known.has(r.id))]
      })
    )
    return () => {
      offRequest()
      offResolved()
    }
  }, [])

  const request = queue[0]
  if (!request) return null

  const chosenMode = mode ?? request.recommendedMode
  const chosenLocation = location ?? request.recommendedLocation

  const decide = (approved: boolean): void => {
    setBusy(true)
    void api
      .resolveWorkerRequest({
        requestId: request.id,
        approved,
        mode: chosenMode,
        location: chosenLocation
      })
      .catch(console.error)
      .finally(() => {
        setQueue((q) => q.filter((r) => r.id !== request.id))
        setMode(null)
        setLocation(null)
        setBusy(false)
      })
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className="w-[480px] rounded-xl border border-white/10 bg-[#131614] p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <IconAstronaut className="size-4 text-emerald-400" stroke={1.75} />
          <h2 className="text-[13px] font-medium text-neutral-100">
            An agent wants to spawn {request.count > 1 ? `${request.count} workers` : 'a worker'}
          </h2>
        </div>

        <div className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-white/[0.04] p-3 text-[12px] leading-relaxed text-neutral-300">
          {request.prompt}
        </div>

        {request.reason && (
          <p className="mt-2 text-[11px] leading-snug text-neutral-500">
            Agent&apos;s assessment: {request.reason}
          </p>
        )}

        <div className="mt-4 space-y-1.5">
          <div className="text-[11px] text-neutral-500">Permissions</div>
          <OptionRow
            options={MODES}
            value={chosenMode}
            recommended={request.recommendedMode}
            onChange={setMode}
          />
        </div>

        <div className="mt-3 space-y-1.5">
          <div className="text-[11px] text-neutral-500">Where it works</div>
          <OptionRow
            options={LOCATIONS}
            value={chosenLocation}
            recommended={request.recommendedLocation}
            onChange={setLocation}
          />
        </div>

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
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            Approve
          </button>
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
