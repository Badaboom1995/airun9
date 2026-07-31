import { useCallback, useEffect, useState } from 'react'
import { IconGitBranch, IconPlus, IconX } from '@tabler/icons-react'
import type { ProjectInfo, WorktreeInfo } from '../../../shared/types'
import ContextMenu from './ContextMenu'
import { api, events } from '../lib/api'
import { useWorkspaceStore } from '../stores/workspace'

/**
 * Inline worktree chips in the rail, shown next to the chosen project's tab
 * (ADR-0011). Each worktree is a full context (child workspace) — clicking a
 * chip switches every block at once; "main" is the repo checkout itself.
 * The + opens a small create form (that form IS the user's consent); ✕ only
 * *requests* removal — the approval card with the blast radius decides.
 */
function WorktreeTabs({ project }: { project: ProjectInfo }): React.JSX.Element {
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [bootstrap, setBootstrap] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; worktreeId: string } | null>(null)

  // a worktree context is a child project whose path IS the worktree path
  const activePath = projects.find((p) => p.id === activeProjectId)?.path ?? null

  const refresh = useCallback(() => {
    void api.listWorktrees(project.id).then(setWorktrees).catch(console.error)
  }, [project.id])

  useEffect(() => {
    refresh()
    return events.onWorktreeChanged(({ projectId }) => {
      if (projectId === project.id) refresh()
    })
  }, [project.id, refresh])

  // the remembered bootstrap command prefills the create form
  useEffect(() => {
    if (!adding) return
    void api
      .worktreeBootstrapCmd(project.id)
      .then(({ cmd }) => setBootstrap((cur) => cur || (cmd ?? '')))
      .catch(console.error)
  }, [adding, project.id])

  const create = (): void => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    void api
      .createWorktree({
        name: trimmed,
        bootstrapCmd: bootstrap.trim() || undefined,
        projectId: project.id
      })
      .then(async ({ worktrees: created }) => {
        // switching to the new context spawns its first terminal (pane
        // adoption); type the bootstrap command into that shell so it stays
        // alive after the install finishes
        const child = await api.activateWorktree(created[0].id, project.id)
        const cmd = bootstrap.trim()
        if (cmd) {
          const terminals = await api.listTerminals()
          const target = terminals.find((t) => t.projectId === child.id && t.status === 'running')
          if (target) void api.writeTerminal(target.id, cmd + '\r')
        }
        setName('')
        setAdding(false)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const base = worktrees.find((w) => w.isMain)

  // non-repo folder: nothing to show
  if (worktrees.length === 0) return <></>

  return (
    // one layer DOWN from the project tab: darker, slightly lower, and
    // tucked underneath it (the tab overlaps this strip's left edge)
    // NOTE: no z-index here — as a flex item it would create a stacking
    // context that traps the + popover and context menu beneath the panes.
    // The project tab still overlaps this strip via its own z-10 wrapper.
    <div className="-ml-2 flex h-8 shrink-0 items-center gap-0.5 rounded-md bg-black/40 pr-1 pl-3">
      {worktrees.map((worktree) => {
        const active = worktree.path === activePath
        return (
          <div
            key={worktree.id}
            className={`flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] transition-colors ${
              active
                ? 'text-neutral-100'
                : 'text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-300'
            }`}
            title={`${worktree.branch ?? 'detached'} @ ${worktree.head}\n${worktree.path}`}
            onClick={() => {
              if (!active) void api.activateWorktree(worktree.id, project.id).catch(console.error)
            }}
            onContextMenu={(event) => {
              // main is the repo checkout itself — nothing to remove there
              if (worktree.isMain) return
              event.preventDefault()
              setMenu({ x: event.clientX, y: event.clientY, worktreeId: worktree.id })
            }}
          >
            <IconGitBranch className="size-3 shrink-0" stroke={1.75} />
            <span className="max-w-28 truncate">{worktree.isMain ? 'main' : worktree.name}</span>
            {worktree.external && <span className="text-[9px] text-neutral-600">ext</span>}
          </div>
        )
      })}

      <div className="relative">
        <button
          type="button"
          className={`flex h-7 w-6 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06] hover:text-neutral-200 ${
            adding ? 'bg-white/[0.06] text-neutral-200' : 'text-neutral-600'
          }`}
          title="New worktree"
          onClick={() => setAdding((cur) => !cur)}
        >
          <IconPlus className="size-3.5" stroke={1.75} />
        </button>

        {adding && (
          <div className="absolute top-full left-0 z-50 mt-2 w-[300px] rounded-xl border border-white/10 bg-[#131614] p-3 shadow-2xl">
            <div className="mb-2 text-[11px] tracking-[0.2em] text-neutral-500">NEW WORKTREE</div>
            <div className="space-y-1.5">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create()
                  if (e.key === 'Escape') setAdding(false)
                }}
                placeholder="name (becomes branch airun9/<name>)"
                className="w-full rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50"
              />
              <input
                value={bootstrap}
                onChange={(e) => setBootstrap(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create()
                  if (e.key === 'Escape') setAdding(false)
                }}
                placeholder="bootstrap command (optional, remembered)"
                className="w-full rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-500/50"
              />
              {base && (
                <div className="text-[10px] text-neutral-600">
                  from {base.branch ?? 'detached'} @ {base.head}
                </div>
              )}
              {error && <div className="text-[11px] text-red-400">{error}</div>}
              <div className="flex justify-end gap-2 pt-0.5">
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-300"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !name.trim()}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  onClick={create}
                >
                  {busy ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Close worktree',
              icon: <IconX className="size-3.5" stroke={2} />,
              onClick: () => {
                // routes through the one removal door: the approval card
                // pops with the blast radius and decides (ADR-0011)
                void api.requestRemoveWorktree(menu.worktreeId, project.id).catch((e: Error) => {
                  if (!e.message.includes('denied')) console.error(e)
                })
              }
            }
          ]}
        />
      )}
    </div>
  )
}

export default WorktreeTabs
