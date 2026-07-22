import { useState } from 'react'
import { IconPlus } from '@tabler/icons-react'
import IconOrbit from './icons/IconOrbit'
import ApprovalCard from './ApprovalCard'
import ContextMenu from './ContextMenu'
import WorktreeApprovalCard from './WorktreeApprovalCard'
import WorktreeTabs from './WorktreeTabs'
import { api } from '../lib/api'
import { useWorkspaceStore } from '../stores/workspace'

/**
 * The project switcher: app chrome, not a layout block — it must survive
 * every project switch (a block would swap away with its own tree). Chips
 * show live vitals: running agents, pending worker approvals. Clicking a
 * background project's approval badge opens the decision inline; closing
 * a project with running agents asks first (everything in it dies).
 */
function ProjectsRail(): React.JSX.Element {
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const workers = useWorkspaceStore((s) => s.workers)
  const terminals = useWorkspaceStore((s) => s.terminals)
  const requests = useWorkspaceStore((s) => s.workerRequests)
  const worktreeRequests = useWorkspaceStore((s) => s.worktreeRequests)
  const [approvalsFor, setApprovalsFor] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; projectId: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  // worktree contexts are child projects — the rail shows one chip per
  // repo and groups everything (requests, agents, sessions) under it
  const topLevel = projects.filter((p) => !p.parentId)
  const rootOf = (id: string): string => {
    const project = projects.find((p) => p.id === id)
    return project?.parentId ?? id
  }

  // stale targets (request resolved, project closed) simply stop matching —
  // the popover/confirm render only while their subject still exists
  const openPopoverFor =
    approvalsFor &&
    (requests.some((r) => rootOf(r.projectId) === approvalsFor) ||
      worktreeRequests.some((r) => rootOf(r.projectId) === approvalsFor))
      ? approvalsFor
      : null

  const openProject = async (): Promise<void> => {
    const target = await window.api.pickDirectory()
    if (target) await api.openProject(target).catch(console.error)
  }

  return (
    <div
      className="flex min-w-0 items-center gap-2.5"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {topLevel.map((project) => {
        // chip is active when the repo OR one of its worktree contexts is
        const activeChild = projects.find(
          (p) => p.id === activeProjectId && p.parentId === project.id
        )
        const active = project.id === activeProjectId || Boolean(activeChild)
        const running = Object.values(workers).filter(
          (w) => rootOf(w.projectId) === project.id && w.status === 'running'
        ).length
        const pending = requests.filter((r) => rootOf(r.projectId) === project.id)
        const wtPending = worktreeRequests.filter((r) => rootOf(r.projectId) === project.id)
        const pendingCount = pending.length + wtPending.length

        return (
          // project tab + its worktree strip read as ONE group: tighter than
          // the gap between projects, tab a layer UP (lighter, solid, nudged
          // higher) overlapping the darker strip tucked underneath
          <div key={project.id} className="flex items-center">
            <div className="relative z-10">
              <div
                className={`group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 transition-colors ${
                  active
                    ? 'bg-[#262b27] text-neutral-100'
                    : 'text-neutral-400 hover:bg-white/[0.05]'
                }`}
                title={project.path}
                onClick={() => {
                  // clicking the chip goes to the repo (main) context
                  if (activeProjectId !== project.id) {
                    void api.activateProject(project.id).catch(console.error)
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ x: event.clientX, y: event.clientY, projectId: project.id })
                }}
              >
                <span className="max-w-36 truncate text-[12px]">{project.name}</span>

                {running > 0 && (
                  <span className="flex items-center gap-0.5 text-[11px] text-emerald-400">
                    <IconOrbit className="size-3" stroke={1.75} spinning />
                    {running}
                  </span>
                )}

                {pendingCount > 0 && (
                  <button
                    type="button"
                    className="rounded bg-amber-500/20 px-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/30"
                    title={`${pendingCount} approval${pendingCount > 1 ? 's' : ''} waiting`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setApprovalsFor((cur) => (cur === project.id ? null : project.id))
                    }}
                  >
                    ❗{pendingCount}
                  </button>
                )}
              </div>

              {/* approve/deny a background project's request without switching */}
              {openPopoverFor === project.id && (pending[0] || wtPending[0]) && (
                <div className="absolute top-full left-0 z-50 mt-2 w-[420px] rounded-xl border border-white/10 bg-[#131614] p-4 shadow-2xl">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-[12px] font-medium text-neutral-100">
                      {pending[0] ? 'Worker' : 'Worktree'} approval — {project.name}
                    </span>
                    <span className="text-[11px] text-neutral-600">
                      {pendingCount > 1 ? `1 of ${pendingCount}` : ''}
                    </span>
                  </div>
                  {pending[0] ? (
                    <ApprovalCard key={pending[0].id} request={pending[0]} />
                  ) : (
                    <WorktreeApprovalCard key={wtPending[0].id} request={wtPending[0]} />
                  )}
                </div>
              )}
            </div>

            {/* the chosen project's worktrees, inline as context tabs */}
            {active && <WorktreeTabs project={project} />}
          </div>
        )
      })}

      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-neutral-200"
        title="Open project"
        onClick={() => void openProject()}
      >
        <IconPlus className="size-4" stroke={1.75} />
      </button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Remove project',
              danger: true,
              onClick: () => setConfirmRemove(menu.projectId)
            }
          ]}
        />
      )}

      {/* the approve window for removal: shows the blast radius (running
          agents, terminals) before anything dies; files stay on disk */}
      {(() => {
        const target = confirmRemove ? projects.find((p) => p.id === confirmRemove) : null
        if (!target) return null
        const running = Object.values(workers).filter(
          (w) => rootOf(w.projectId) === target.id && w.status === 'running'
        ).length
        const termCount = terminals.filter((t) => rootOf(t.projectId) === target.id).length
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
            <div className="w-[400px] rounded-xl border border-white/10 bg-[#131614] p-5 shadow-2xl">
              <h2 className="text-[13px] font-medium text-neutral-100">Remove {target.name}?</h2>
              <p className="mt-1 truncate text-[11px] text-neutral-600">{target.path}</p>
              <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
                Removes the project from the workspace
                {running > 0 || termCount > 0 ? (
                  <>
                    {' — '}
                    <span className="text-amber-300">
                      {running} running agent{running === 1 ? '' : 's'} and {termCount} terminal
                      {termCount === 1 ? '' : 's'} will be killed
                    </span>
                  </>
                ) : null}
                . Files on disk are untouched.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md px-3 py-1.5 text-[12px] text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-200"
                  onClick={() => setConfirmRemove(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-md bg-red-600 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-red-500"
                  onClick={() => {
                    setConfirmRemove(null)
                    void api.closeProject(target.id).catch(console.error)
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

export default ProjectsRail
