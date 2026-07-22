import { Menu, nativeImage, Tray } from 'electron'
import type { WorkerManager } from './workers'

/**
 * Tray presence (docs/plans/pty-daemon.md phase 5). Once agents can outlive
 * the IDE window, the tray is the user's handle on them: see how many are
 * running, and choose between quitting-but-keeping them and stopping
 * everything ("Quit Completely" — the resource escape hatch).
 */
export function initTray(opts: {
  iconPath: string
  workers: WorkerManager
  onOpen: () => void
  onQuitKeep: () => void
  onQuitStop: () => void
}): void {
  const icon = nativeImage.createFromPath(opts.iconPath).resize({ width: 18, height: 18 })
  const tray = new Tray(icon)
  tray.setToolTip('AIRUN9')

  const rebuild = (): void => {
    const running = opts.workers.list().filter((w) => w.status === 'running').length
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: running === 0 ? 'No agents running' : `${running} agent${running === 1 ? '' : 's'} running`,
          enabled: false
        },
        { type: 'separator' },
        { label: 'Open AIRUN9', click: opts.onOpen },
        { type: 'separator' },
        { label: 'Quit (keep agents running)', click: opts.onQuitKeep },
        { label: 'Quit Completely (stop agents)', click: opts.onQuitStop }
      ])
    )
  }

  rebuild()
  opts.workers.on('created', rebuild)
  opts.workers.on('updated', rebuild)
}
