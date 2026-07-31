import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  EVENT_CHANNELS,
  type Airun9Bridge,
  type EventChannel,
  type RpcResponse
} from '../shared/types'

// Custom APIs for renderer
const api: Airun9Bridge = {
  rpc: (method: string, params?: unknown): Promise<RpcResponse> =>
    ipcRenderer.invoke('rpc', method, params),

  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),

  on: (channel: EventChannel, callback: (payload: unknown) => void): (() => void) => {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error(`Unknown event channel: ${channel}`)
    }
    const listener = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
