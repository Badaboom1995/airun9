import { useEffect, useRef, useState } from 'react'
import { EVENT_CHANNELS, type EventChannel } from '../../../../shared/types'
import { api, events } from '../../lib/api'
import type { BlockPaneProps } from './registry'

/**
 * Hosts a user/agent-authored block in a null-origin sandboxed iframe
 * (ADR-0003 v2, Figma-plugin model). The block's only channel to the app is
 * a MessagePort; every rpc is checked against its granted capabilities
 * before being forwarded to the dispatcher.
 */

interface RpcMessage {
  type: 'rpc'
  id: number
  method: string
  params?: unknown
}
interface SubscribeMessage {
  type: 'subscribe'
  channel: string
}

function buildSrcdoc(code: string): string {
  const safe = code.replace(/<\/script/gi, '<\\/script')
  return (
    '<!doctype html><html><head>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;\">" +
    '<style>body{margin:0;background:#0b0e0c;color:#d6d8d6;font:13px ui-sans-serif,system-ui}</style>' +
    '</head><body><div id="root"></div>' +
    `<script>${safe}</script></body></html>`
  )
}

function CustomBlockHost({ config }: BlockPaneProps<{ name: string }>): React.JSX.Element {
  const { name } = config
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  const [granted, setGranted] = useState<Set<string> | null>(null)
  // keyed by load attempt so a reload implicitly clears the previous error
  const [loadError, setLoadError] = useState<{ version: number; message: string } | null>(null)
  const [version, setVersion] = useState(0)
  const error = loadError && loadError.version === version ? loadError.message : null

  // load bundle + resolve grants (grant call may wait on the user's dialog)
  useEffect(() => {
    let disposed = false
    void Promise.all([api.blockBundle(name), api.blockGrant(name)])
      .then(([bundle, grant]) => {
        if (disposed) return
        setGranted(new Set(grant.granted))
        setSrcdoc(buildSrcdoc(bundle.code))
      })
      .catch((e: Error) => !disposed && setLoadError({ version, message: e.message }))
    const offUpdated = events.onBlockUpdated((event) => {
      if (event.name === name) setVersion((v) => v + 1)
    })
    return () => {
      disposed = true
      offUpdated()
    }
  }, [name, version])

  // handshake + message bridge: the block pings 'ready' until we answer
  // with a port, so no iframe load-order race is possible
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !srcdoc || !granted) return

    const subscriptions: Array<() => void> = []
    let port: MessagePort | null = null

    const onReady = (readyEvent: MessageEvent): void => {
      if (readyEvent.source !== iframe.contentWindow) return
      if (readyEvent.data?.type !== 'airun9:ready' || port) return
      const channel = new MessageChannel()
      port = channel.port1
      port.onmessage = (event: MessageEvent) => {
        const message = event.data as RpcMessage | SubscribeMessage
        if (message.type === 'rpc') {
          if (!granted.has(message.method)) {
            port?.postMessage({
              type: 'rpc:result',
              id: message.id,
              error: `capability not granted: ${message.method}`
            })
            return
          }
          void window.api.rpc(message.method, message.params).then((response) => {
            port?.postMessage({
              type: 'rpc:result',
              id: message.id,
              result: response.result,
              error: response.error?.message
            })
          })
        } else if (message.type === 'subscribe') {
          if (EVENT_CHANNELS.includes(message.channel as EventChannel)) {
            subscriptions.push(
              window.api.on(message.channel as EventChannel, (payload) =>
                port?.postMessage({ type: 'event', channel: message.channel, payload })
              )
            )
          }
        }
      }
      iframe.contentWindow?.postMessage({ type: 'airun9:init' }, '*', [channel.port2])
    }

    window.addEventListener('message', onReady)
    return () => {
      window.removeEventListener('message', onReady)
      subscriptions.forEach((off) => off())
      port?.close()
    }
  }, [srcdoc, granted])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[12px] text-red-400/80">
        Block “{name}” failed: {error}
      </div>
    )
  }
  if (!srcdoc) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-neutral-600">
        Loading block “{name}”…
      </div>
    )
  }
  return (
    <iframe
      ref={iframeRef}
      title={`block:${name}`}
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      className="h-full w-full border-0"
    />
  )
}

export default CustomBlockHost
