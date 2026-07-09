import { useEffect } from 'react'
import { IconPlus, IconRobot, IconX } from '@tabler/icons-react'
import type { TerminalInfo } from '../../../shared/types'
import { api, events } from '../lib/api'
import { useWorkspaceStore } from '../stores/workspace'
import TerminalView from './TerminalView'

// Survives StrictMode double-mount: only ever auto-create the first terminal once
let bootstrapped = false

function TabLabel({ terminal }: { terminal: TerminalInfo }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {terminal.workerId && (
        <IconRobot
          className={`size-3.5 shrink-0 ${
            terminal.status === 'running' ? 'text-emerald-400' : 'text-neutral-600'
          }`}
          stroke={1.75}
        />
      )}
      <span
        className={`truncate text-[12px] ${
          terminal.status === 'exited' ? 'text-neutral-600 line-through' : ''
        }`}
      >
        {terminal.title}
      </span>
    </span>
  )
}

function Workspace(): React.JSX.Element {
  const project = useWorkspaceStore((s) => s.project)
  const terminals = useWorkspaceStore((s) => s.terminals)
  const activeTerminalId = useWorkspaceStore((s) => s.activeTerminalId)
  const { setTerminals, upsertTerminal, removeTerminal, markTerminalExited, setActiveTerminal } =
    useWorkspaceStore.getState()

  useEffect(() => {
    // Subscribe before fetching so nothing created in between is missed
    const offCreated = events.onTerminalCreated((info) => upsertTerminal(info))
    const offClosed = events.onTerminalClosed(({ id }) => removeTerminal(id))
    const offExit = events.onTerminalExit(({ id, exitCode }) => markTerminalExited(id, exitCode))

    void api.listTerminals().then((list) => {
      setTerminals(list)
      if (list.length === 0 && !bootstrapped) {
        bootstrapped = true
        void api.createTerminal().then((info) => setActiveTerminal(info.id))
      }
    })

    return () => {
      offCreated()
      offClosed()
      offExit()
    }
  }, [markTerminalExited, removeTerminal, setActiveTerminal, setTerminals, upsertTerminal])

  const createTerminal = (): void => {
    void api.createTerminal().then((info) => setActiveTerminal(info.id))
  }

  const closeTerminal = (id: string): void => {
    void api.closeTerminal(id)
  }

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

      {/* terminal tabs */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
        {terminals.map((terminal) => (
          <div
            key={terminal.id}
            className={`group flex h-7 max-w-48 cursor-pointer items-center gap-1 rounded-md px-2.5 transition-colors ${
              terminal.id === activeTerminalId
                ? 'bg-white/[0.08] text-neutral-100'
                : 'text-neutral-400 hover:bg-white/[0.04]'
            }`}
            onClick={() => setActiveTerminal(terminal.id)}
          >
            <TabLabel terminal={terminal} />
            <button
              type="button"
              className="ml-0.5 rounded p-0.5 text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.08] hover:text-neutral-300"
              onClick={(event) => {
                event.stopPropagation()
                closeTerminal(terminal.id)
              }}
            >
              <IconX className="size-3" stroke={2} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-neutral-200"
          onClick={createTerminal}
          title="New terminal"
        >
          <IconPlus className="size-4" stroke={1.75} />
        </button>
      </div>

      {/* terminal area — all mounted, one visible, so tab switches are instant */}
      <div className="relative min-h-0 flex-1">
        {terminals.length === 0 && (
          <div className="flex h-full items-center justify-center text-[13px] text-neutral-600">
            No terminals — create one with the + button
          </div>
        )}
        {terminals.map((terminal) => (
          <TerminalView
            key={terminal.id}
            id={terminal.id}
            active={terminal.id === activeTerminalId}
          />
        ))}
      </div>
    </div>
  )
}

export default Workspace
