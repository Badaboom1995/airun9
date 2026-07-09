import { useEffect } from 'react'
import { api, events } from '../lib/api'
import { useWorkspaceStore } from '../stores/workspace'
import LayoutRenderer from './LayoutRenderer'
import WorkerApprovalModal from './WorkerApprovalModal'
import BlockGrantModal from './BlockGrantModal'

// Survives StrictMode double-mount: only ever auto-create the first terminal once
let bootstrapped = false

function Workspace(): React.JSX.Element {
  const project = useWorkspaceStore((s) => s.project)
  const layout = useWorkspaceStore((s) => s.layout)
  const {
    setTerminals,
    upsertTerminal,
    removeTerminal,
    markTerminalExited,
    setWorkers,
    upsertWorker,
    setLayout,
    setBlocks
  } = useWorkspaceStore.getState()

  useEffect(() => {
    // Subscribe before fetching so nothing created in between is missed
    const offs = [
      events.onTerminalCreated(upsertTerminal),
      events.onTerminalClosed(({ id }) => removeTerminal(id)),
      events.onTerminalExit(({ id, exitCode }) => markTerminalExited(id, exitCode)),
      events.onWorkerCreated(upsertWorker),
      events.onWorkerUpdated(upsertWorker),
      events.onLayoutChanged(setLayout),
      events.onBlocksChanged(setBlocks)
    ]

    void api.getLayout().then(setLayout)
    void api.listWorkers().then(setWorkers)
    void api.listBlocks().then(setBlocks)
    void api.listTerminals().then((list) => {
      setTerminals(list)
      if (list.length === 0 && !bootstrapped) {
        bootstrapped = true
        void api.createTerminal()
      }
    })

    return () => offs.forEach((off) => off())
  }, [
    markTerminalExited,
    removeTerminal,
    setBlocks,
    setLayout,
    setTerminals,
    setWorkers,
    upsertTerminal,
    upsertWorker
  ])

  return (
    <div className="flex h-screen w-screen flex-col bg-[#0b0e0c] text-neutral-200 antialiased">
      {/* title bar: draggable, padded for macOS traffic lights */}
      <div
        className="flex h-10 shrink-0 items-center gap-3 border-b border-white/[0.06] pr-3 pl-20"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="font-michroma text-[11px] tracking-[0.25em] text-neutral-400">AIRUN9</span>
        <span className="text-[12px] text-neutral-500">{project?.name}</span>
        <span className="truncate text-[11px] text-neutral-700">{project?.path}</span>
      </div>

      {/* the layout tree is the workspace (ADR-0001) */}
      <div className="relative min-h-0 flex-1">
        {layout ? (
          <LayoutRenderer node={layout} first />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-neutral-600">
            Loading workspace…
          </div>
        )}
        <WorkerApprovalModal />
        <BlockGrantModal />
      </div>
    </div>
  )
}

export default Workspace
