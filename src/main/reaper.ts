import type { ProjectManager } from './projects'
import type { TerminalClient } from './terminals'
import type { WorkerManager } from './workers'

const REAP_INTERVAL_MS = 5 * 60 * 1000
const FIRST_PASS_DELAY_MS = 15 * 1000

/**
 * Terminal garbage collector (docs/plans/pty-daemon.md phase 6). A daemon
 * that outlives the IDE can accumulate sessions nobody owns anymore — a
 * crash between "kill it" and it dying, a project row edited away. Every
 * 5 minutes, close daemon sessions that no open project or worker record
 * claims. Deliberately conservative: it only reaps what is provably
 * unowned, never a user shell in a live project.
 */
export function startTerminalReaper(opts: {
  terminals: TerminalClient
  workers: WorkerManager
  projects: ProjectManager
}): void {
  const reap = (): void => {
    const projectIds = new Set(opts.projects.list().map((p) => p.id))
    const workerIds = new Set(opts.workers.list().map((w) => w.id))
    for (const terminal of opts.terminals.list()) {
      const orphanProject = !projectIds.has(terminal.projectId)
      const orphanWorker = terminal.workerId !== null && !workerIds.has(terminal.workerId)
      if (orphanProject || orphanWorker) {
        console.log(
          `[reaper] closing unowned terminal ${terminal.id} (project ${terminal.projectId}, worker ${terminal.workerId ?? 'none'})`
        )
        opts.terminals.close(terminal.id)
      }
    }
  }
  // first pass waits out startup: adoption and rehydration must settle first
  setTimeout(reap, FIRST_PASS_DELAY_MS).unref()
  setInterval(reap, REAP_INTERVAL_MS).unref()
}
