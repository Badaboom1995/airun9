/**
 * airun9 block SDK — inlined into every custom-block bundle at compile time.
 * The block runs in a null-origin sandboxed iframe; a MessagePort handed
 * over at init is its only channel to the app. Every rpc() goes through the
 * host's capability check before reaching the API dispatcher.
 */

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

let port: MessagePort | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const listeners = new Map<string, Set<(payload: unknown) => void>>()

/**
 * Handshake with the host. The block announces readiness (retrying, so no
 * load-order race is possible) and the host answers with a MessagePort.
 * Called by the generated bootstrap.
 */
export function __connect(): Promise<void> {
  return new Promise((resolve) => {
    const onInit = (event: MessageEvent): void => {
      if (event.data?.type !== 'airun9:init' || !event.ports[0]) return
      window.removeEventListener('message', onInit)
      clearInterval(announceTimer)
      port = event.ports[0]
      port.onmessage = onPortMessage
      resolve()
    }
    window.addEventListener('message', onInit)
    const announce = (): void => window.parent.postMessage({ type: 'airun9:ready' }, '*')
    const announceTimer = setInterval(announce, 100)
    announce()
  })
}

function onPortMessage(event: MessageEvent): void {
  const message = event.data as {
    type: string
    id?: number
    result?: unknown
    error?: string
    channel?: string
    payload?: unknown
  }
  if (message.type === 'rpc:result' && message.id !== undefined) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(message.error))
    else entry.resolve(message.result)
  } else if (message.type === 'event' && message.channel) {
    listeners.get(message.channel)?.forEach((cb) => cb(message.payload))
  }
}

/** Call an AIRUN9 API method (must be declared in block.json capabilities) */
export function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (!port) return Promise.reject(new Error('airun9: not connected'))
  const id = nextId++
  port.postMessage({ type: 'rpc', id, method, params })
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
  })
}

/** Subscribe to an app push channel (terminal:*, worker:*, layout:changed…) */
export function on(channel: string, callback: (payload: unknown) => void): () => void {
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set())
    port?.postMessage({ type: 'subscribe', channel })
  }
  const set = listeners.get(channel)!
  set.add(callback)
  return () => set.delete(callback)
}
