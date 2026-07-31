import { useEffect, useState } from 'react'
import { IconPuzzle } from '@tabler/icons-react'
import type { BlockGrantRequest } from '../../../shared/types'
import { api, events } from '../lib/api'

/**
 * One-time capability grant for custom blocks (ADR-0003/0004): read-only
 * capabilities pass silently; this dialog covers the mutating ones.
 */
function BlockGrantModal(): React.JSX.Element | null {
  const [queue, setQueue] = useState<BlockGrantRequest[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const offRequest = events.onBlockGrantRequest((request) =>
      setQueue((q) => (q.some((r) => r.id === request.id) ? q : [...q, request]))
    )
    const offResolved = events.onBlockGrantResolved(({ requestId }) =>
      setQueue((q) => q.filter((r) => r.id !== requestId))
    )
    void api.pendingBlockGrants().then((pending) =>
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

  const decide = (approved: boolean): void => {
    setBusy(true)
    void api
      .resolveBlockGrant(request.id, approved)
      .catch(console.error)
      .finally(() => {
        setQueue((q) => q.filter((r) => r.id !== request.id))
        setBusy(false)
      })
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className="w-[420px] rounded-xl border border-white/10 bg-[#131614] p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <IconPuzzle className="size-4 text-sky-400" stroke={1.75} />
          <h2 className="text-[13px] font-medium text-neutral-100">
            Block “{request.title}” requests capabilities
          </h2>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-neutral-500">
          These API methods can modify things. Denying keeps the block running with read-only
          access.
        </p>
        <ul className="mt-3 space-y-1 rounded-lg bg-white/[0.04] p-3">
          {request.capabilities.map((capability) => (
            <li key={capability} className="font-mono text-[12px] text-amber-300/90">
              {capability}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => decide(false)}
            className="rounded-md px-3 py-1.5 text-[12px] text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-200 disabled:opacity-50"
          >
            Read-only
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => decide(true)}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
          >
            Grant
          </button>
        </div>
      </div>
    </div>
  )
}

export default BlockGrantModal
