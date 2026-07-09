import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { ProjectInfo } from '../shared/types'
import { TerminalManager } from './terminals'
import { WorkerManager } from './workers'
import { buildApi, dispatch } from './api'
import { startSocketServer, stopSocketServer, SOCKET_PATH } from './socket'
import { zshBootstrapEnv } from './shell-env'

let currentProject: ProjectInfo | null = null

// Managed terminals get the airun9 CLI on PATH and the socket path in env,
// so any agent running inside can call the public API (ADR-0008).
const cliBinDir = is.dev
  ? join(app.getAppPath(), 'resources', 'bin')
  : join(process.resourcesPath, 'bin')

const terminals = new TerminalManager(() => ({
  AIRUN9_SOCKET: SOCKET_PATH,
  // plain prepend for shells without a bootstrap; zsh gets the reliable
  // ZDOTDIR route since user rc files often rebuild PATH and wipe this
  PATH: `${cliBinDir}:${process.env.PATH ?? ''}`,
  ...zshBootstrapEnv(cliBinDir)
}))
const workers = new WorkerManager(terminals, cliBinDir)

const api = buildApi({
  terminals,
  workers,
  getProject: () => currentProject,
  setProject: (project) => {
    currentProject = project
  }
})

const socketServer = startSocketServer(api)

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

terminals.on('created', (info) => broadcast('terminal:created', info))
terminals.on('data', (event) => broadcast('terminal:data', event))
terminals.on('exit', (event) => broadcast('terminal:exit', event))
terminals.on('closed', (event) => broadcast('terminal:closed', event))
workers.on('created', (worker) => broadcast('worker:created', worker))
workers.on('updated', (worker) => broadcast('worker:updated', worker))
workers.on('request', (request) => broadcast('worker:request', request))
workers.on('request-resolved', (resolution) => broadcast('worker:request-resolved', resolution))

ipcMain.handle('rpc', async (_event, method: string, params: unknown) => {
  try {
    return { result: await dispatch(api, method, params) }
  } catch (error) {
    return { error: { message: error instanceof Error ? error.message : String(error) } }
  }
})

ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Open project'
  })
  return canceled ? null : filePaths[0]
})

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0e0c',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  nativeTheme.themeSource = 'dark'

  // In dev the dock shows the default Electron icon; packaged builds use build/icon.icns
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  terminals.disposeAll()
  stopSocketServer(socketServer)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
