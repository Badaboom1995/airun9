import { useRef, useState } from 'react'
import { IconPlus, IconPuzzle, IconRobot, IconX } from '@tabler/icons-react'
import type { LayoutNode, LayoutTabItem, SplitNode, TabsNode } from '../../../shared/types'
import { api } from '../lib/api'
import { useWorkspaceStore } from '../stores/workspace'
import PaneHost from './PaneHost'

/**
 * Renders the serialized layout tree (ADR-0001): split nodes become flex
 * containers with draggable dividers, tabs nodes become tab groups. All
 * mutations go through the layout API — this component owns no layout state.
 */

const WORKER_STATUS_COLOR: Record<string, string> = {
  running: 'text-emerald-400',
  done: 'text-amber-400',
  exited: 'text-neutral-600'
}

function TabLabel({ item }: { item: LayoutTabItem }): React.JSX.Element {
  const terminals = useWorkspaceStore((s) => s.terminals)
  const workers = useWorkspaceStore((s) => s.workers)
  const blocks = useWorkspaceStore((s) => s.blocks)

  if (item.block === 'terminal') {
    const terminal = terminals.find((t) => t.id === item.config.terminalId)
    const worker = terminal ? workers[terminal.id] : undefined
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {terminal?.workerId && (
          <IconRobot
            className={`size-3.5 shrink-0 ${WORKER_STATUS_COLOR[worker?.status ?? 'exited']}`}
            stroke={1.75}
          />
        )}
        <span
          className={`truncate text-[12px] ${
            terminal?.status === 'exited' ? 'text-neutral-600 line-through' : ''
          }`}
        >
          {terminal?.title ?? 'terminal'}
        </span>
      </span>
    )
  }

  const name = String(item.config.name ?? item.block)
  const block = blocks.find((b) => b.name === name)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <IconPuzzle className="size-3.5 shrink-0 text-sky-400" stroke={1.75} />
      <span className="truncate text-[12px]">{block?.manifest.title ?? name}</span>
    </span>
  )
}

function closeItem(item: LayoutTabItem): void {
  if (item.block === 'terminal') {
    void api.closeTerminal(String(item.config.terminalId))
  } else {
    void api.removeLayoutItem(item.id)
  }
}

function TabGroup({ node, first }: { node: TabsNode; first: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
        {node.items.map((item) => (
          <div
            key={item.id}
            className={`group flex h-7 max-w-48 cursor-pointer items-center gap-1 rounded-md px-2.5 transition-colors ${
              item.id === node.active
                ? 'bg-white/[0.08] text-neutral-100'
                : 'text-neutral-400 hover:bg-white/[0.04]'
            }`}
            onClick={() => void api.setLayoutActive(node.id, item.id)}
          >
            <TabLabel item={item} />
            <button
              type="button"
              className="ml-0.5 rounded p-0.5 text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.08] hover:text-neutral-300"
              onClick={(event) => {
                event.stopPropagation()
                closeItem(item)
              }}
            >
              <IconX className="size-3" stroke={2} />
            </button>
          </div>
        ))}
        {first && (
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-neutral-200"
            onClick={() => void api.createTerminal()}
            title="New terminal"
          >
            <IconPlus className="size-4" stroke={1.75} />
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {node.items.length === 0 && (
          <div className="flex h-full items-center justify-center text-[13px] text-neutral-600">
            No panes — create a terminal with the + button
          </div>
        )}
        {node.items.map((item) => (
          <div key={item.id} className={item.id === node.active ? 'absolute inset-0' : 'hidden'}>
            <PaneHost item={item} active={item.id === node.active} />
          </div>
        ))}
      </div>
    </div>
  )
}

function SplitView({ node, first }: { node: SplitNode; first: boolean }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // drag state is only honored while it belongs to the current server ratios
  // (a layout:changed push delivers a fresh array, invalidating it by identity)
  const [drag, setDrag] = useState<{ base: number[]; values: number[] } | null>(null)
  const ratios = drag && drag.base === node.ratios ? drag.values : node.ratios
  const isRow = node.direction === 'row'

  const startDrag = (index: number, event: React.PointerEvent): void => {
    const container = containerRef.current
    if (!container) return
    event.preventDefault()
    const total = isRow ? container.clientWidth : container.clientHeight
    const startPos = isRow ? event.clientX : event.clientY
    const startRatios = [...ratios]
    let current = startRatios

    const onMove = (e: PointerEvent): void => {
      const delta = ((isRow ? e.clientX : e.clientY) - startPos) / total
      const next = [...startRatios]
      const moved = Math.max(
        0.1,
        Math.min(startRatios[index] + startRatios[index + 1] - 0.1, startRatios[index] + delta)
      )
      next[index] = moved
      next[index + 1] = startRatios[index] + startRatios[index + 1] - moved
      current = next
      setDrag({ base: node.ratios, values: next })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      void api.setLayoutRatios(node.id, current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-0 w-full ${isRow ? 'flex-row' : 'flex-col'}`}
    >
      {node.children.map((child, i) => (
        <div key={childKey(child)} className="contents">
          <div style={{ flex: `${ratios[i]} 1 0%` }} className="min-h-0 min-w-0 overflow-hidden">
            <LayoutRenderer node={child} first={first && i === 0} />
          </div>
          {i < node.children.length - 1 && (
            <div
              className={`shrink-0 bg-white/[0.06] transition-colors hover:bg-white/[0.16] ${
                isRow ? 'w-[3px] cursor-col-resize' : 'h-[3px] cursor-row-resize'
              }`}
              onPointerDown={(event) => startDrag(i, event)}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function childKey(node: LayoutNode): string {
  return node.id
}

function LayoutRenderer({ node, first }: { node: LayoutNode; first: boolean }): React.JSX.Element {
  if (node.type === 'tabs') return <TabGroup node={node} first={first} />
  return <SplitView node={node} first={first} />
}

export default LayoutRenderer
