import { ElectronAPI } from '@electron-toolkit/preload'
import type { Airun9Bridge } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: Airun9Bridge
  }
}
