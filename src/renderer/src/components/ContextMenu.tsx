import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  /** Rendered before the label (size-3.5 icons read best) */
  icon?: React.ReactNode
  danger?: boolean
  onClick: () => void
}

/**
 * Minimal right-click menu: fixed at the cursor, clamped to the viewport,
 * dismissed by any outside press, another right-click, Escape, or window
 * blur. An item closes the menu first, then acts.
 */
function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - 8),
      y: Math.min(y, window.innerHeight - rect.height - 8)
    })
  }, [x, y])

  useEffect(() => {
    const dismiss = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', dismiss, true)
    window.addEventListener('contextmenu', dismiss, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('contextmenu', dismiss, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // portaled to <body>: the menu must never be trapped by an ancestor's
  // stacking context (rail chips, worktree strip, pane layers all make them)
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[70] min-w-44 rounded-lg border border-white/10 bg-[#131614]/70 p-1 shadow-2xl backdrop-blur-xl"
      style={{ left: pos.x, top: pos.y, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
            item.danger
              ? 'text-red-400 hover:bg-red-500/10'
              : 'text-neutral-300 hover:bg-white/[0.06]'
          }`}
          onClick={() => {
            onClose()
            item.onClick()
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}

export default ContextMenu
