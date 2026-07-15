import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconChevronRight,
  IconFile,
  IconFiles,
  IconFolder,
  IconFolderOpen,
  IconRefresh
} from '@tabler/icons-react'
import type { FileEntry, LayoutNode, ProjectInfo, TabsNode } from '../../../../shared/types'
import { api, events } from '../../lib/api'
import type { BlockPaneProps } from './registry'

/**
 * Built-in file explorer: lazy tree over fs.list rooted at the open project.
 * Clicking a file opens a real `file` reader pane beside this block — split
 * toward the workspace center (right by default; left when this block sits
 * in the right half of the grid) — and retargets that same pane on later
 * clicks instead of opening more panes.
 */

const ROOT = '.'

/** Path from the root to the tabs node holding itemId (that node comes last) */
function pathToItem(node: LayoutNode, itemId: string): LayoutNode[] | null {
  if (node.type === 'tabs') {
    return node.items.some((item) => item.id === itemId) ? [node] : null
  }
  for (const child of node.children) {
    const sub = pathToItem(child, itemId)
    if (sub) return [node, ...sub]
  }
  return null
}

/** Horizontal span [start, end] ⊂ [0, 1] of the tabs group holding itemId */
function horizontalSpan(
  node: LayoutNode,
  itemId: string,
  start: number,
  end: number
): { start: number; end: number } | null {
  if (node.type === 'tabs') {
    return node.items.some((item) => item.id === itemId) ? { start, end } : null
  }
  const total = node.ratios.reduce((a, b) => a + b, 0) || 1
  let cursor = 0
  for (let i = 0; i < node.children.length; i++) {
    const fraction = (node.ratios[i] ?? 0) / total
    const found = horizontalSpan(
      node.children[i],
      itemId,
      node.direction === 'row' ? start + (end - start) * cursor : start,
      node.direction === 'row' ? start + (end - start) * (cursor + fraction) : end
    )
    if (found) return found
    cursor += fraction
  }
  return null
}

function FilesBlock({ itemId }: BlockPaneProps): React.JSX.Element {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  /** file currently shown in the reader pane this block opened */
  const [selected, setSelected] = useState<string | null>(null)

  const layoutRef = useRef<LayoutNode | null>(null)
  /** layout item id of our reader pane, if it is still in the layout */
  const readerRef = useRef<string | null>(null)

  const loadDir = useCallback(async (path: string): Promise<void> => {
    const entries = await api.listFiles(path)
    setChildren((prev) => ({ ...prev, [path]: entries }))
  }, [])

  useEffect(() => {
    void api.getProject().then(setProject)
    void api
      .listFiles(ROOT)
      .then((entries) => setChildren((prev) => ({ ...prev, [ROOT]: entries })))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  // track the layout to place the reader, and drop the selection highlight
  // when the user closes the reader pane
  useEffect(() => {
    const handle = (layout: LayoutNode): void => {
      layoutRef.current = layout
      if (readerRef.current && !pathToItem(layout, readerRef.current)) {
        readerRef.current = null
        setSelected(null)
      }
    }
    void api.getLayout().then(handle)
    // this block always renders inside the active project's tree, so only
    // that project's layout events concern it
    return events.onLayoutChanged(({ root }) => handle(root))
  }, [])

  const toggleDir = (path: string): void => {
    const isOpen = expanded.has(path)
    const next = new Set(expanded)
    if (isOpen) next.delete(path)
    else next.add(path)
    setExpanded(next)
    if (!isOpen && !children[path]) {
      loadDir(path).catch(() =>
        setExpanded((prev) => {
          const collapsed = new Set(prev)
          collapsed.delete(path)
          return collapsed
        })
      )
    }
  }

  const openFile = (path: string): void => {
    setSelected(path)
    const layout = layoutRef.current
    const readerId = readerRef.current
    // retarget the existing reader pane and surface its tab
    const readerPath = layout && readerId ? pathToItem(layout, readerId) : null
    if (readerId && readerPath) {
      void api.updateLayoutItem(readerId, { path })
      const tabs = readerPath[readerPath.length - 1] as TabsNode
      if (tabs.active !== readerId) void api.setLayoutActive(tabs.id, readerId)
      return
    }
    // open beside this block, toward the workspace center
    const span = layout ? horizontalSpan(layout, itemId, 0, 1) : null
    const side = span && (span.start + span.end) / 2 > 0.5 ? 'left' : 'right'
    api
      .openLayoutBeside(itemId, 'file', { path }, side)
      .then((item) => {
        readerRef.current = item.id
      })
      .catch((e) => {
        console.error('files: opening reader failed:', e)
        setSelected(null)
      })
  }

  const refresh = (): void => {
    setError(null)
    loadDir(ROOT).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    for (const dir of expanded) {
      loadDir(dir).catch(() =>
        setExpanded((prev) => {
          const collapsed = new Set(prev)
          collapsed.delete(dir)
          return collapsed
        })
      )
    }
  }

  const renderDir = (path: string, depth: number): React.JSX.Element => {
    const entries = children[path]
    if (!entries) {
      return (
        <div
          className="px-2 py-1 text-[11px] text-neutral-600"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          Loading…
        </div>
      )
    }
    if (entries.length === 0) {
      return (
        <div
          className="px-2 py-1 text-[11px] text-neutral-700"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          empty
        </div>
      )
    }
    return (
      <>
        {entries.map((entry) => {
          const isOpen = entry.type === 'dir' && expanded.has(entry.path)
          return (
            <div key={entry.path}>
              <button
                type="button"
                onClick={() =>
                  entry.type === 'dir' ? toggleDir(entry.path) : openFile(entry.path)
                }
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] transition-colors ${
                  selected === entry.path
                    ? 'bg-white/[0.08] text-neutral-100'
                    : 'text-neutral-300 hover:bg-white/[0.05]'
                }`}
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                {entry.type === 'dir' ? (
                  <>
                    <IconChevronRight
                      className={`size-3.5 shrink-0 text-neutral-500 transition-transform ${
                        isOpen ? 'rotate-90' : ''
                      }`}
                      stroke={1.75}
                    />
                    {isOpen ? (
                      <IconFolderOpen className="size-4 shrink-0 text-neutral-500" stroke={1.5} />
                    ) : (
                      <IconFolder className="size-4 shrink-0 text-neutral-500" stroke={1.5} />
                    )}
                  </>
                ) : (
                  <>
                    <span className="w-3.5 shrink-0" />
                    <IconFile className="size-4 shrink-0 text-neutral-600" stroke={1.5} />
                  </>
                )}
                <span className="truncate">{entry.name}</span>
              </button>
              {isOpen && renderDir(entry.path, depth + 1)}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
        <IconFiles className="size-4 text-neutral-400" stroke={1.75} />
        <h3 className="text-[11px] tracking-[0.2em] text-neutral-400">FILES</h3>
        {project && <span className="truncate text-[11px] text-neutral-600">{project.name}</span>}
        <button
          type="button"
          title="Refresh"
          onClick={refresh}
          className="ml-auto rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-white/[0.08] hover:text-neutral-100"
        >
          <IconRefresh className="size-3.5" stroke={1.75} />
        </button>
      </div>

      {error ? (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[12px] text-red-400/80">
          {error}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">{renderDir(ROOT, 0)}</div>
      )}
    </div>
  )
}

export default FilesBlock
