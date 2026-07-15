import { useState } from 'react'
import { IconPlus, IconX } from '@tabler/icons-react'
import IconOrbit from './icons/IconOrbit'
import ApprovalCard from './ApprovalCard'
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
  const requests = useWorkspaceStore((s) => s.workerRequests)
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [approvalsFor, setApprovalsFor] = useState<string | null>(null)
  // stale targets (request resolved, project closed) simply stop matching —
  // the popover/confirm render only while their subject still exists
  const openPopoverFor =
    approvalsFor && requests.some((r) => r.projectId === approvalsFor) ? approvalsFor : null

  const openProject = async (): Promise<void> => {
    const target = await window.api.pickDirectory()
    if (target) await api.openProject(target).catch(console.error)
  }

  const closeProject = (id: string): void => {
    setConfirmClose(null)
    void api.closeProject(id).catch(console.error)
  }

  return (
    <div
      className="flex min-w-0 items-center gap-1"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {projects.map((project) => {
        const active = project.id === activeProjectId
        const running = Object.values(workers).filter(
          (w) => w.projectId === project.id && w.status === 'running'
        ).length
        const pending = requests.filter((r) => r.projectId === project.id)
        const confirming = confirmClose === project.id

        return (
          <div key={project.id} className="relative">
            <div
              className={`group flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 transition-colors ${
                active
                  ? 'bg-white/[0.08] text-neutral-100'
                  : 'text-neutral-400 hover:bg-white/[0.05]'
              }`}
              title={project.path}
              onClick={() => {
                if (!active) void api.activateProject(project.id).catch(console.error)
              }}
            >
              <span className="max-w-36 truncate text-[12px]">{project.name}</span>

              {running > 0 && (
                <span className="flex items-center gap-0.5 text-[11px] text-emerald-400">
                  <IconOrbit className="size-3" stroke={1.75} spinning />
                  {running}
                </span>
              )}

              {pending.length > 0 && (
                <button
                  type="button"
                  className="rounded bg-amber-500/20 px-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/30"
                  title={`${pending.length} worker approval${pending.length > 1 ? 's' : ''} waiting`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setApprovalsFor((cur) => (cur === project.id ? null : project.id))
                  }}
                >
                  ❗{pending.length}
                </button>
              )}

              {confirming ? (
                <span className="flex items-center gap-1 text-[11px] text-red-300">
                  kill {running > 0 ? `${running} agent${running > 1 ? 's' : ''}?` : 'all?'}
                  <button
                    type="button"
                    className="rounded bg-red-500/20 px-1 hover:bg-red-500/40"
                    onClick={(event) => {
                      event.stopPropagation()
                      closeProject(project.id)
                    }}
                  >
                    yes
                  </button>
                  <button
                    type="button"
                    className="rounded px-1 hover:bg-white/[0.08]"
                    onClick={(event) => {
                      event.stopPropagation()
                      setConfirmClose(null)
                    }}
                  >
                    no
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="rounded p-0.5 text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.08] hover:text-neutral-300"
                  title="Close project"
                  onClick={(event) => {
                    event.stopPropagation()
                    // silent close only when nothing is at stake
                    if (running > 0 || pending.length > 0) setConfirmClose(project.id)
                    else closeProject(project.id)
                  }}
                >
                  <IconX className="size-3" stroke={2} />
                </button>
              )}
            </div>

            {/* approve/deny a background project's request without switching */}
            {openPopoverFor === project.id && pending[0] && (
              <div className="absolute top-full left-0 z-50 mt-2 w-[420px] rounded-xl border border-white/10 bg-[#131614] p-4 shadow-2xl">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-neutral-100">
                    Worker approval — {project.name}
                  </span>
                  <span className="text-[11px] text-neutral-600">
                    {pending.length > 1 ? `1 of ${pending.length}` : ''}
                  </span>
                </div>
                <ApprovalCard key={pending[0].id} request={pending[0]} />
              </div>
            )}
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
    </div>
  )
}

export default ProjectsRail
