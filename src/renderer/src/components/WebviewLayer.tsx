import { useEffect, useRef, useState } from 'react'
import { BROWSER_PARTITION, type BrowserInfo } from '../../../shared/types'
import { api } from '../lib/api'
import { useWorkspaceStore } from '../stores/workspace'
import { useWebviewRects } from '../stores/webviewRects'

/**
 * The persistent home of every <webview> (the VS Code webview pattern).
 * A <webview>'s page dies if the element unmounts or even moves in the
 * DOM — so none of them ever do either. They live here for the lifetime
 * of their browser session, across tab switches AND project switches
 * (background projects keep their pages alive), and simply position
 * themselves over their pane's placeholder rect when it is visible.
 */

interface WebviewElement extends HTMLElement {
  getWebContentsId(): number
}

function PersistentWebview({ browser }: { browser: BrowserInfo }): React.JSX.Element | null {
  const webviewRef = useRef<WebviewElement | null>(null)
  // the placement keeps the last on-screen rect while hidden, so the page
  // doesn't reflow to 0×0 when its project goes to the background
  const placement = useWebviewRects((s) => s.placements[browser.id])

  // src is set once from main's record; navigation after that flows through
  // the API, so this element never remounts on URL changes
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    api
      .getBrowser(browser.id)
      .then((record) => !disposed && setSrc(record.url))
      .catch(() => !disposed && setSrc(null))
    return () => {
      disposed = true
    }
  }, [browser.id])

  // hand the guest to main; dom-ready fires per document load, attach is
  // idempotent for the same guest so re-fires are harmless
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || src === null) return
    const attach = (): void => {
      void api.attachBrowser(browser.id, webview.getWebContentsId()).catch(() => {})
    }
    webview.addEventListener('dom-ready', attach)
    return () => webview.removeEventListener('dom-ready', attach)
  }, [browser.id, src])

  if (src === null) return null
  const rect = placement?.rect
  return (
    <webview
      ref={webviewRef}
      src={src}
      // eslint-disable-next-line react/no-unknown-property -- Electron webview attribute
      partition={BROWSER_PARTITION}
      // eslint-disable-next-line react/no-unknown-property -- Electron webview attribute
      allowpopups
      style={{
        position: 'absolute',
        left: rect?.x ?? 0,
        top: rect?.y ?? 0,
        width: rect?.width ?? 800,
        height: rect?.height ?? 600,
        visibility: placement?.visible ? 'visible' : 'hidden',
        pointerEvents: 'auto'
      }}
    />
  )
}

function WebviewLayer(): React.JSX.Element {
  const browsers = useWorkspaceStore((s) => s.browsers)
  return (
    // pointer-events pass through everywhere except the webviews themselves;
    // no z-index so modals/popovers (z-50) stay above the pages
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      {browsers.map((browser) => (
        <PersistentWebview key={browser.id} browser={browser} />
      ))}
    </div>
  )
}

export default WebviewLayer
