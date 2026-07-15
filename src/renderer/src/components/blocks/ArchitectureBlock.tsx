import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconFocusCentered, IconMinus, IconPlus, IconSchema } from '@tabler/icons-react'
import type { ArchEdge, ArchitectureState, ArchModule } from '../../../../shared/types'
import { api, events } from '../../lib/api'
import { useWorkspaceStore } from '../../stores/workspace'

/**
 * Built-in architecture map: renders the agent-maintained schema from the
 * project's .airun9/architecture.json as a column-per-group node graph.
 * Layout is deterministic (groups → columns, modules stacked in file order)
 * so the agent controls the picture by ordering the JSON.
 */

const NODE_W = 208
const NODE_H = 58
/** horizontal gap between nodes within a band */
const NODE_GAP = 20
/** vertical gap between wrapped rows inside one band */
const ROW_GAP = 16
/** vertical gap between bands — room for the edges to curve */
const BAND_GAP = 90
const PAD = 24
const HEADER_H = 30
/** a band wraps its modules to the next row past this many per row */
const MAX_PER_ROW = 3

const MIN_ZOOM = 0.15
const MAX_ZOOM = 2.5

interface PositionedModule {
  module: ArchModule
  x: number
  y: number
}

interface GraphLayout {
  bands: { id: string; title: string; y: number }[]
  nodes: Map<string, PositionedModule>
  width: number
  height: number
  maxLoc: number
}

/** Canvas transform: content pixel p maps to viewport pixel p*k + (x,y) */
interface View {
  x: number
  y: number
  k: number
}

function computeLayout(state: ArchitectureState): GraphLayout | null {
  const schema = state.schema
  if (!schema || schema.modules.length === 0) return null

  // declared groups first (in order), then any group ids only referenced by
  // modules, then an implicit bucket for ungrouped modules
  const declared = schema.groups ?? []
  const columnIds = declared.map((g) => g.id)
  const titles = new Map(declared.map((g) => [g.id, g.title]))
  for (const module of schema.modules) {
    const group = module.group ?? 'other'
    if (!columnIds.includes(group)) {
      columnIds.push(group)
      titles.set(group, group === 'other' ? 'Other' : group)
    }
  }
  const used = columnIds.filter((id) => schema.modules.some((m) => (m.group ?? 'other') === id))

  // groups stack top-to-bottom as horizontal bands; modules flow left-to-right
  // and wrap past MAX_PER_ROW, each row centered within the composition
  const perRow = MAX_PER_ROW
  const widest = Math.min(
    perRow,
    Math.max(...used.map((id) => schema.modules.filter((m) => (m.group ?? 'other') === id).length))
  )
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * NODE_GAP

  const nodes = new Map<string, PositionedModule>()
  let cursor = PAD
  const bands = used.map((id) => {
    const y = cursor
    const members = schema.modules.filter((m) => (m.group ?? 'other') === id)
    const rowCount = Math.ceil(members.length / perRow)
    members.forEach((module, index) => {
      const row = Math.floor(index / perRow)
      const inRow = Math.min(perRow, members.length - row * perRow)
      const rowWidth = inRow * NODE_W + (inRow - 1) * NODE_GAP
      nodes.set(module.id, {
        module,
        x: (width - rowWidth) / 2 + (index % perRow) * (NODE_W + NODE_GAP),
        y: y + HEADER_H + row * (NODE_H + ROW_GAP)
      })
    })
    cursor += HEADER_H + rowCount * NODE_H + (rowCount - 1) * ROW_GAP + BAND_GAP
    return { id, title: titles.get(id) ?? id, y }
  })

  return {
    bands,
    nodes,
    width,
    height: cursor - BAND_GAP + PAD,
    maxLoc: Math.max(1, ...schema.modules.map((m) => m.loc ?? 0))
  }
}

function edgePath(from: PositionedModule, to: PositionedModule): string {
  const sx = from.x + NODE_W / 2
  const tx = to.x + NODE_W / 2
  if (to.y > from.y) {
    const sy = from.y + NODE_H
    const dy = Math.max(28, (to.y - sy) / 2)
    return `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${to.y - dy}, ${tx} ${to.y}`
  }
  if (to.y < from.y) {
    const ty = to.y + NODE_H
    const dy = Math.max(28, (from.y - ty) / 2)
    return `M ${sx} ${from.y} C ${sx} ${from.y - dy}, ${tx} ${ty + dy}, ${tx} ${ty}`
  }
  // same band: bulge downward
  const sy = from.y + NODE_H
  return `M ${sx} ${sy} C ${sx} ${sy + 40}, ${tx} ${sy + 40}, ${tx} ${sy}`
}

const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))

function ArchitectureBlock(): React.JSX.Element {
  const [state, setState] = useState<ArchitectureState | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [panning, setPanning] = useState(false)

  const viewportRef = useRef<HTMLDivElement>(null)
  const fittedRef = useRef(false)
  // pan-in-progress bookkeeping; `moved` also suppresses the click that
  // lands after a drag so panning never toggles selection
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const movedRef = useRef(false)

  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  useEffect(() => {
    // every open project's watcher emits; this block shows the active one
    const off = events.onArchitectureChanged((next) => {
      if (next.projectId === useWorkspaceStore.getState().activeProjectId) setState(next)
    })
    void api.getArchitecture().then(setState)
    return off
  }, [activeProjectId])

  const layout = useMemo(() => (state ? computeLayout(state) : null), [state])

  const fitToView = useCallback(() => {
    const viewport = viewportRef.current
    if (!layout || !viewport) return
    const k = clampZoom(
      Math.min(
        1,
        (viewport.clientWidth - 48) / layout.width,
        (viewport.clientHeight - 48) / layout.height
      )
    )
    setView({
      k,
      x: (viewport.clientWidth - layout.width * k) / 2,
      y: (viewport.clientHeight - layout.height * k) / 2
    })
  }, [layout])

  // fit once when the schema first renders; later edits keep the user's view
  useLayoutEffect(() => {
    if (layout && !fittedRef.current) {
      fittedRef.current = true
      fitToView()
    }
  }, [layout, fitToView])

  // native listener: React's onWheel is passive, so it cannot preventDefault
  // (needed to stop Electron's page zoom / overscroll navigation)
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        // pinch (Chromium reports trackpad pinch as ctrl+wheel): zoom toward cursor
        const rect = viewport.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        setView((v) => {
          const k = clampZoom(v.k * Math.exp(-e.deltaY * 0.01))
          const r = k / v.k
          return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }
        })
      } else {
        // two-finger scroll pans, like an infinite canvas
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [layout])

  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const px = viewport.clientWidth / 2
    const py = viewport.clientHeight / 2
    setView((v) => {
      const k = clampZoom(v.k * factor)
      const r = k / v.k
      return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }
    })
  }, [])

  const focusId = hovered ?? selected
  const connected = useMemo(() => {
    const ids = new Set<string>()
    if (!focusId || !state?.schema?.edges) return ids
    for (const edge of state.schema.edges) {
      if (edge.from === focusId) ids.add(edge.to)
      if (edge.to === focusId) ids.add(edge.from)
    }
    return ids
  }, [focusId, state])

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-neutral-600">
        Loading…
      </div>
    )
  }

  const selectedModule = (selected && state.schema?.modules.find((m) => m.id === selected)) || null

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
        <IconSchema className="size-4 text-neutral-400" stroke={1.75} />
        <h3 className="text-[11px] tracking-[0.2em] text-neutral-400">ARCHITECTURE</h3>
        {state.schema?.updatedAt && (
          <span className="text-[11px] text-neutral-600">
            updated {new Date(state.schema.updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {state.error ? (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[12px] text-red-400/80">
          .airun9/architecture.json failed to parse: {state.error}
        </div>
      ) : !layout ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <span className="text-[13px] text-neutral-400">No architecture schema yet</span>
          <span className="max-w-md text-[12px] leading-relaxed text-neutral-600">
            Ask your agent to map this codebase — it should research the project and write{' '}
            <code className="text-neutral-500">.airun9/architecture.json</code> with modules, edges
            and line counts. This view updates live when the file changes.
          </span>
        </div>
      ) : (
        <div
          ref={viewportRef}
          className={`relative min-h-0 flex-1 select-none overflow-hidden ${
            panning ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            dragRef.current = { x: e.clientX, y: e.clientY }
            movedRef.current = false
            setPanning(true)
          }}
          onPointerMove={(e) => {
            const drag = dragRef.current
            if (!drag) return
            const dx = e.clientX - drag.x
            const dy = e.clientY - drag.y
            if (!movedRef.current && Math.hypot(dx, dy) < 4) return
            if (!movedRef.current) {
              movedRef.current = true
              e.currentTarget.setPointerCapture(e.pointerId)
            }
            drag.x = e.clientX
            drag.y = e.clientY
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
          }}
          onPointerUp={() => {
            dragRef.current = null
            setPanning(false)
          }}
          onPointerCancel={() => {
            dragRef.current = null
            setPanning(false)
          }}
          onClick={() => {
            if (!movedRef.current) setSelected(null)
          }}
        >
          <div
            className="absolute"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
              transformOrigin: '0 0'
            }}
          >
            <svg
              className="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
            >
              {(state.schema?.edges ?? []).map((edge: ArchEdge, i) => {
                const from = layout.nodes.get(edge.from)
                const to = layout.nodes.get(edge.to)
                if (!from || !to) return null
                const active = focusId !== null && (edge.from === focusId || edge.to === focusId)
                const dimmed = focusId !== null && !active
                return (
                  <path
                    key={i}
                    d={edgePath(from, to)}
                    fill="none"
                    stroke={active ? '#98c379' : 'rgba(255,255,255,0.14)'}
                    strokeWidth={active ? 1.5 : 1}
                    opacity={dimmed ? 0.25 : 1}
                  />
                )
              })}
            </svg>

            {layout.bands.map((band) => (
              <div
                key={band.id}
                className="absolute text-center text-[10px] tracking-[0.18em] text-neutral-500 uppercase"
                style={{ left: 0, top: band.y, width: layout.width }}
              >
                {band.title}
              </div>
            ))}

            {[...layout.nodes.values()].map(({ module, x, y }) => {
              const isFocus = focusId === module.id
              const isNeighbor = connected.has(module.id)
              const dimmed = focusId !== null && !isFocus && !isNeighbor
              return (
                <div
                  key={module.id}
                  onMouseEnter={() => setHovered(module.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (movedRef.current) return
                    setSelected(module.id === selected ? null : module.id)
                  }}
                  className={`absolute cursor-pointer rounded-lg border px-3 py-2 transition-colors ${
                    isFocus
                      ? 'border-[#98c379]/60 bg-white/[0.06]'
                      : 'border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.05]'
                  }`}
                  style={{
                    left: x,
                    top: y,
                    width: NODE_W,
                    height: NODE_H,
                    opacity: dimmed ? 0.4 : 1
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12px] text-neutral-100">{module.title}</span>
                    {module.loc !== undefined && (
                      <span className="shrink-0 text-[10px] text-neutral-500">{module.loc}</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-neutral-600">{module.path}</div>
                  {module.loc !== undefined && (
                    <div className="mt-1.5 h-0.5 rounded bg-white/[0.06]">
                      <div
                        className="h-full rounded bg-[#98c379]/50"
                        style={{ width: `${Math.max(3, (module.loc / layout.maxLoc) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0b0e0c]/85 p-1 backdrop-blur">
            <button
              type="button"
              title="Zoom out"
              onClick={(e) => {
                e.stopPropagation()
                zoomBy(1 / 1.25)
              }}
              className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-white/[0.08] hover:text-neutral-100"
            >
              <IconMinus className="size-3.5" stroke={1.75} />
            </button>
            <button
              type="button"
              title="Reset zoom to 100%"
              onClick={(e) => {
                e.stopPropagation()
                setView((v) => ({ ...v, k: 1 }))
              }}
              className="w-11 rounded-md py-1 text-center text-[11px] text-neutral-400 tabular-nums transition-colors hover:bg-white/[0.08] hover:text-neutral-100"
            >
              {Math.round(view.k * 100)}%
            </button>
            <button
              type="button"
              title="Zoom in"
              onClick={(e) => {
                e.stopPropagation()
                zoomBy(1.25)
              }}
              className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-white/[0.08] hover:text-neutral-100"
            >
              <IconPlus className="size-3.5" stroke={1.75} />
            </button>
            <button
              type="button"
              title="Fit to view"
              onClick={(e) => {
                e.stopPropagation()
                fitToView()
              }}
              className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-white/[0.08] hover:text-neutral-100"
            >
              <IconFocusCentered className="size-3.5" stroke={1.75} />
            </button>
          </div>
        </div>
      )}

      {selectedModule && (
        <div className="shrink-0 border-t border-white/[0.06] px-4 py-3">
          <div className="flex items-baseline gap-3">
            <span className="text-[13px] text-neutral-100">{selectedModule.title}</span>
            <span className="text-[11px] text-neutral-500">{selectedModule.path}</span>
            {selectedModule.loc !== undefined && (
              <span className="text-[11px] text-neutral-600">{selectedModule.loc} loc</span>
            )}
          </div>
          {selectedModule.summary && (
            <div className="mt-1 text-[12px] leading-relaxed text-neutral-400">
              {selectedModule.summary}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ArchitectureBlock
