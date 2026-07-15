import { useEffect } from 'react'
import { api, events } from '../lib/api'
import { useWorkspaceStore } from '../stores/workspace'
import LayoutRenderer from './LayoutRenderer'
import ProjectsRail from './ProjectsRail'
import WebviewLayer from './WebviewLayer'
import WorkerApprovalModal from './WorkerApprovalModal'
import BlockGrantModal from './BlockGrantModal'

function Workspace(): React.JSX.Element {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const layout = useWorkspaceStore((s) => s.layout)
  const {
    setTerminals,
    upsertTerminal,
    removeTerminal,
    markTerminalExited,
    setWorkers,
    upsertWorker,
    setWorkerRequests,
    upsertWorkerRequest,
    removeWorkerRequest,
    setLayout,
    setBlocks,
    setBrowsers,
    upsertBrowser,
    removeBrowser
  } = useWorkspaceStore.getState()

  useEffect(() => {
    // Subscribe before fetching so nothing created in between is missed
    const offs = [
      events.onTerminalCreated(upsertTerminal),
      events.onTerminalClosed(({ id }) => removeTerminal(id)),
      events.onTerminalExit(({ id, exitCode }) => markTerminalExited(id, exitCode)),
      events.onWorkerCreated(upsertWorker),
      events.onWorkerUpdated(upsertWorker),
      events.onWorkerRequest(upsertWorkerRequest),
      events.onWorkerRequestResolved(({ requestId }) => removeWorkerRequest(requestId)),
      events.onBrowserCreated(upsertBrowser),
      events.onBrowserUpdated(upsertBrowser),
      events.onBrowserClosed(({ id }) => removeBrowser(id)),
      // trees are per-project; only the visible one lives in the store
      events.onLayoutChanged(({ projectId, root }) => {
        if (projectId === useWorkspaceStore.getState().activeProjectId) setLayout(root)
      }),
      events.onBlocksChanged(setBlocks)
    ]

    void api.listBrowsers().then(setBrowsers)
    void api.listWorkers().then(setWorkers)
    void api.pendingWorkerRequests().then(setWorkerRequests)
    void api.listBlocks().then(setBlocks)
    void api.listTerminals().then(setTerminals)

    return () => offs.forEach((off) => off())
  }, [
    markTerminalExited,
    removeBrowser,
    removeTerminal,
    removeWorkerRequest,
    setBlocks,
    setBrowsers,
    setLayout,
    setTerminals,
    setWorkerRequests,
    setWorkers,
    upsertBrowser,
    upsertTerminal,
    upsertWorker,
    upsertWorkerRequest
  ])

  // the visible tree follows the active project (main adopts panes on
  // activation, so by the time this resolves the sessions are alive)
  useEffect(() => {
    if (!activeProjectId) return
    let stale = false
    void api.getLayout().then((root) => {
      if (!stale) setLayout(root)
    })
    return () => {
      stale = true
    }
  }, [activeProjectId, setLayout])

  return (
    <div className="flex h-screen w-screen flex-col bg-[#0b0e0c] text-neutral-200 antialiased">
      {/* title bar: draggable, padded for macOS traffic lights */}
      <div
        className="flex h-10 shrink-0 items-center gap-3 border-b border-white/[0.06] pr-3 pl-20"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="font-michroma text-[11px] tracking-[0.25em] text-neutral-400">AIRUN9</span>
        <ProjectsRail />
      </div>

      {/* the layout tree is the workspace (ADR-0001) */}
      <div className="relative min-h-0 flex-1">
        {layout ? (
          <LayoutRenderer node={layout} />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-neutral-600">
            Loading workspace…
          </div>
        )}
        <WorkerApprovalModal />
        <BlockGrantModal />
      </div>

      {/* all <webview>s live here permanently — never unmounted by tab or
          project switches, so pages survive in the background */}
      <WebviewLayer />
    </div>
  )
}

export default Workspace
