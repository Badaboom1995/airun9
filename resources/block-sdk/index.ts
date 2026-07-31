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

/**
 * Per-block persistent key-value store. The sandboxed iframe has a null
 * origin, so localStorage/indexedDB throw — this is the durable alternative.
 * Namespacing is enforced by the host (it stamps the block's name onto the
 * call), so declaring storage.get/storage.set in block.json is all it takes.
 *
 * Scope defaults to the current project — a notes block's notes follow the
 * project the user has open. Pass { scope: 'global' } to share one store
 * across all projects.
 */
export interface StorageOptions {
  scope?: 'project' | 'global'
}

export const storage = {
  get<T = unknown>(key: string, options?: StorageOptions): Promise<T | null> {
    return rpc<{ value: T | null }>('storage.get', { key, scope: options?.scope }).then(
      (r) => r.value
    )
  },
  set(key: string, value: unknown, options?: StorageOptions): Promise<void> {
    return rpc('storage.set', { key, value, scope: options?.scope }).then(() => undefined)
  }
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
