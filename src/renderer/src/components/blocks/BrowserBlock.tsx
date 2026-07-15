import { useLayoutEffect, useRef, useState } from 'react'
import {
  IconArrowLeft,
  IconArrowRight,
  IconLock,
  IconRotateClockwise,
  IconWorld,
  IconX
} from '@tabler/icons-react'
import { api } from '../../lib/api'
import { useWorkspaceStore } from '../../stores/workspace'
import { useWebviewRects } from '../../stores/webviewRects'
import type { BlockPaneProps } from './registry'

/**
 * A browser pane: toolbar + a placeholder rect. The actual <webview> lives
 * in the persistent WebviewLayer (it would lose its page if it unmounted
 * with this pane on a tab or project switch) and positions itself over the
 * placeholder, which reports its on-screen rect here. Every toolbar action
 * goes through the same browser.* API agents use — this component is just
 * another API client (ADR-0008).
 */

function BrowserBlock({ config }: BlockPaneProps<{ browserId: string }>): React.JSX.Element {
  const { browserId } = config
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const info = useWorkspaceStore((s) => s.browsers.find((b) => b.id === browserId))
  const [editing, setEditing] = useState<string | null>(null)

  // report where the page should render; anything that can move or hide
  // this pane funnels through here (splits resize it, tab/project switches
  // display:none an ancestor, which ResizeObserver reports as 0×0)
  useLayoutEffect(() => {
    const element = placeholderRef.current
    if (!element) return
    const { setRect, hide } = useWebviewRects.getState()
    let frame = 0
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setRect(browserId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      } else {
        hide(browserId)
      }
    }
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(report)
    }
    report()
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener('resize', schedule)
    // position-only moves (a sibling pane resized) don't fire the observer;
    // any such change comes with a store update, so re-measure on those
    const unsubscribe = useWorkspaceStore.subscribe(schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      unsubscribe()
      // unmounting (project switch, pane removal) hides the page but keeps
      // its geometry — the session may come back on the next switch
      hide(browserId)
    }
  }, [browserId])

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-neutral-600">
        This browser session is gone — open a new one
      </div>
    )
  }

  const shownUrl = editing ?? info.url
  const secure = info.url.startsWith('https://')

  const navigate = (value: string): void => {
    setEditing(null)
    if (value.trim() !== '') void api.navigateBrowser(browserId, value)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
        <ToolbarButton
          title="Back"
          disabled={!info.canGoBack}
          onClick={() => void api.browserBack(browserId)}
        >
          <IconArrowLeft className="size-4" stroke={1.75} />
        </ToolbarButton>
        <ToolbarButton
          title="Forward"
          disabled={!info.canGoForward}
          onClick={() => void api.browserForward(browserId)}
        >
          <IconArrowRight className="size-4" stroke={1.75} />
        </ToolbarButton>
        <ToolbarButton
          title={info.loading ? 'Stop' : 'Reload'}
          onClick={() =>
            void (info.loading ? api.browserStop(browserId) : api.browserReload(browserId))
          }
        >
          {info.loading ? (
            <IconX className="size-4" stroke={1.75} />
          ) : (
            <IconRotateClockwise className="size-4" stroke={1.75} />
          )}
        </ToolbarButton>
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-white/[0.05] px-2.5">
          {secure ? (
            <IconLock className="size-3.5 shrink-0 text-neutral-500" stroke={1.75} />
          ) : (
            <IconWorld className="size-3.5 shrink-0 text-neutral-500" stroke={1.75} />
          )}
          <input
            className="w-full bg-transparent text-[12px] text-neutral-300 outline-none placeholder:text-neutral-600"
            value={shownUrl}
            placeholder="Search or enter address"
            spellCheck={false}
            onFocus={(event) => {
              setEditing(info.url)
              event.currentTarget.select()
            }}
            onBlur={() => setEditing(null)}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                navigate(event.currentTarget.value)
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                setEditing(null)
                event.currentTarget.blur()
              }
            }}
          />
        </div>
      </div>
      {/* the WebviewLayer's <webview> renders exactly over this rect */}
      <div ref={placeholderRef} className="min-h-0 flex-1 bg-white" />
    </div>
  )
}

function ToolbarButton({
  title,
  disabled,
  onClick,
  children
}: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-neutral-400 transition-colors enabled:hover:bg-white/[0.06] enabled:hover:text-neutral-200 disabled:text-neutral-700"
    >
      {children}
    </button>
  )
}

export default BrowserBlock
