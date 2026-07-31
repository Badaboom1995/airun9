import { create } from 'zustand'

export interface WebviewRect {
  x: number
  y: number
  width: number
  height: number
}

interface WebviewPlacement {
  /** last known on-screen rect — kept while hidden so the page holds its size */
  rect: WebviewRect
  visible: boolean
}

/**
 * Where each browser pane's placeholder currently sits on screen.
 * BrowserBlock placeholders report; the persistent WebviewLayer positions
 * the real <webview> elements over them. hide() rather than delete on
 * unmount: a project switch removes the placeholder but the page keeps its
 * last geometry, invisible, until the pane comes back.
 */
interface WebviewRectsState {
  placements: Record<string, WebviewPlacement>
  setRect: (browserId: string, rect: WebviewRect) => void
  hide: (browserId: string) => void
}

export const useWebviewRects = create<WebviewRectsState>((set) => ({
  placements: {},
  setRect: (browserId, rect) =>
    set((state) => ({
      placements: { ...state.placements, [browserId]: { rect, visible: true } }
    })),
  hide: (browserId) =>
    set((state) => {
      const current = state.placements[browserId]
      if (!current || !current.visible) return state
      return {
        placements: { ...state.placements, [browserId]: { ...current, visible: false } }
      }
    })
}))
