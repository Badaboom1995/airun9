import { IconFolderOpen, IconPlus, IconX } from '@tabler/icons-react'
import IconOrbit from '../icons/IconOrbit'
import ApprovalCard from '../ApprovalCard'
import WorktreeApprovalCard from '../WorktreeApprovalCard'
import { api } from '../../lib/api'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * Built-in projects board: the rail's data as a full pane — every open
 * project with its vitals (terminals, agents, pending approvals), switch on
 * click, close with inline confirm via the rail's pattern. The rail is the
 * guaranteed escape hatch (app chrome, always visible); this block is the
 * everything-is-blocks view of the same state, for layouts that want it.
 */
function ProjectsBlock(): React.JSX.Element {
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const terminals = useWorkspaceStore((s) => s.terminals)
  const workers = useWorkspaceStore((s) => s.workers)
  const requests = useWorkspaceStore((s) => s.workerRequests)
  const worktreeRequests = useWorkspaceStore((s) => s.worktreeRequests)

  const openProject = async (): Promise<void> => {
    const target = await window.api.pickDirectory()
    if (target) await api.openProject(target).catch(console.error)
  }

  // worktree contexts are child projects; the board shows one card per
  // repo with everything aggregated under it
  const topLevel = projects.filter((p) => !p.parentId)
  const rootOf = (id: string): string => {
    const project = projects.find((p) => p.id === id)
    return project?.parentId ?? id
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <IconFolderOpen className="size-4 text-neutral-400" stroke={1.75} />
          <h3 className="text-[11px] tracking-[0.2em] text-neutral-400">PROJECTS</h3>
        </div>
        <button
          type="button"
          className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-200"
          onClick={() => void openProject()}
        >
          <IconPlus className="size-3.5" stroke={1.75} /> open project
        </button>
      </div>

      {topLevel.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-neutral-600">
          No projects open
        </div>
      ) : (
        <ul className="space-y-2">
          {topLevel.map((project) => {
            const active = rootOf(activeProjectId ?? '') === project.id
            const termCount = terminals.filter((t) => rootOf(t.projectId) === project.id).length
            const projectWorkers = Object.values(workers).filter(
              (w) => rootOf(w.projectId) === project.id
            )
            const running = projectWorkers.filter((w) => w.status === 'running').length
            const pending = requests.filter((r) => rootOf(r.projectId) === project.id)
            const wtPending = worktreeRequests.filter((r) => rootOf(r.projectId) === project.id)
            const pendingCount = pending.length + wtPending.length

            return (
              <li
                key={project.id}
                className={`cursor-pointer rounded-xl border p-3 transition-colors ${
                  active
                    ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'
                }`}
                onClick={() => {
                  if (!active) void api.activateProject(project.id).catch(console.error)
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      active ? 'bg-emerald-400' : 'bg-neutral-600'
                    }`}
                  />
                  <span className="truncate text-[13px] text-neutral-100">{project.name}</span>
                  {running > 0 && (
                    <span className="flex items-center gap-0.5 text-[11px] text-emerald-400">
                      <IconOrbit className="size-3" stroke={1.75} spinning /> {running}
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-neutral-600">
                    {termCount} term · {projectWorkers.length} agent
                    {projectWorkers.length === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 text-neutral-600 transition-colors hover:bg-white/[0.08] hover:text-neutral-300"
                    title="Close project (kills its sessions)"
                    onClick={(event) => {
                      event.stopPropagation()
                      const risky = running > 0 || pendingCount > 0
                      if (
                        !risky ||
                        window.confirm(
                          `Close ${project.name}? ${running} running agent${running === 1 ? '' : 's'} and all its terminals will be killed.`
                        )
                      ) {
                        void api.closeProject(project.id).catch(console.error)
                      }
                    }}
                  >
                    <IconX className="size-3.5" stroke={2} />
                  </button>
                </div>
                <div className="mt-0.5 truncate pl-3.5 text-[11px] text-neutral-600">
                  {project.path}
                </div>

                {/* pending approvals are decidable right here, per project */}
                {(pending[0] || wtPending[0]) && (
                  <div
                    className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="mb-2 text-[11px] font-medium text-amber-300">
                      {pending[0] ? 'Worker' : 'Worktree'} approval waiting
                      {pendingCount > 1 ? ` (1 of ${pendingCount})` : ''}
                    </div>
                    {pending[0] ? (
                      <ApprovalCard key={pending[0].id} request={pending[0]} />
                    ) : (
                      <WorktreeApprovalCard key={wtPending[0].id} request={wtPending[0]} />
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default ProjectsBlock
