import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { ProjectInfo } from '../shared/types'
import { TerminalClient } from './terminals'
import { BrowserManager } from './browser'
import { WorkerManager } from './workers'
import { WorktreeManager } from './worktrees'
import { LayoutManager } from './layout'
import { ProjectManager } from './projects'
import { BlocksManager, BLOCK_CSP, BUILTIN_BLOCK_INFOS } from './blocks'
import { buildApi, dispatch } from './api'
import { BlockStorage } from './storage'
import { ArchitectureManager } from './architecture'
import { MemoryManager } from './memory'
import { startSocketServer, stopSocketServer, SOCKET_PATH } from './socket'
import { zshBootstrapEnv } from './shell-env'

// Block documents load from their own scheme so they carry their own CSP
// instead of inheriting the app page's (srcdoc iframes inherit the embedder's
// policy, which forbids inline scripts and left blocks blank). Must be
// registered before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'airun9-block', privileges: { standard: true, secure: true } }
])

// Managed terminals get the airun9 CLI on PATH and the socket path in env,
// so any agent running inside can call the public API (ADR-0008).
const cliBinDir = is.dev
  ? join(app.getAppPath(), 'resources', 'bin')
  : join(process.resourcesPath, 'bin')

const terminals = new TerminalClient(
  () => ({
    AIRUN9_SOCKET: SOCKET_PATH,
    // plain prepend for shells without a bootstrap; zsh gets the reliable
    // ZDOTDIR route since user rc files often rebuild PATH and wipe this
    PATH: `${cliBinDir}:${process.env.PATH ?? ''}`,
    ...zshBootstrapEnv(cliBinDir)
  }),
  is.dev
)
const storage = new BlockStorage()
const layout = new LayoutManager()
const projects = new ProjectManager()
const worktrees = new WorktreeManager(terminals, storage, projects)
const workers = new WorkerManager(terminals, worktrees, cliBinDir)
// circular by nature: workers create worktrees, worktree removal stops workers
worktrees.bindWorkers(workers)
const blocks = new BlocksManager(
  is.dev
    ? join(app.getAppPath(), 'resources', 'block-sdk', 'index.ts')
    : join(process.resourcesPath, 'block-sdk', 'index.ts'),
  join(app.getAppPath(), 'node_modules')
)

// Restored layout panes reference dead sessions (PTYs and pages don't
// survive a restart). Instead of dropping the panes — which collapsed their
// splits and merged survivors into one tab group — respawn a fresh shell /
// browser session into each pane. Lazy: runs when a project is activated,
// so launching with many projects doesn't boot a pile of idle shells.
// Re-activating an already-adopted project is a no-op (sessions are live).
let adoptingPanes = false
async function adoptPanes(project: ProjectInfo): Promise<void> {
  // with the PTY daemon, panes from the previous run usually ARE still live —
  // reattachment is the no-op path; respawn remains the reboot fallback
  const liveTerminals = new Set(terminals.list().map((t) => t.id))
  const liveBrowsers = new Set(browsers.list().map((b) => b.id))
  adoptingPanes = true
  try {
    for (const item of layout.items(project.id)) {
      try {
        if (item.block === 'terminal' && !liveTerminals.has(String(item.config.terminalId))) {
          const info = await terminals.create({ projectId: project.id, cwd: project.path })
          layout.updateItemConfig(project.id, item.id, { terminalId: info.id })
        } else if (item.block === 'browser' && !liveBrowsers.has(String(item.config.browserId))) {
          // pane configs carry the last URL (stamped on navigation below)
          const url = typeof item.config.url === 'string' ? item.config.url : undefined
          const info = browsers.create({ projectId: project.id, url })
          layout.updateItemConfig(project.id, item.id, { browserId: info.id, url: info.url })
        }
      } catch (error) {
        console.error('pane adoption failed, dropping pane:', error)
        layout.removeItem(project.id, item.id)
      }
    }
    // a fresh (or all-closed) workspace starts with one terminal
    if (!layout.items(project.id).some((item) => item.block === 'terminal')) {
      adoptingPanes = false
      await terminals.create({ projectId: project.id, cwd: project.path })
    }
  } finally {
    adoptingPanes = false
  }
}

// terminals are panes: their lifecycle maintains their project's layout tree
terminals.on('created', (info) => {
  if (!adoptingPanes) {
    layout.addItem(info.projectId, { block: 'terminal', config: { terminalId: info.id } })
  }
})
terminals.on('closed', ({ id, projectId }) => {
  layout.removeWhere(
    projectId,
    (item) => item.block === 'terminal' && item.config.terminalId === id
  )
})

// browsers too — creating a session (user, agent, or a page's window.open)
// is what puts the pane on screen
const browsers = new BrowserManager()
browsers.on('created', ({ info, position }) => {
  if (!adoptingPanes) {
    layout.addItem(
      info.projectId,
      { block: 'browser', config: { browserId: info.id, url: info.url } },
      position
    )
  }
})
browsers.on('closed', ({ id, projectId }) => {
  layout.removeWhere(projectId, (item) => item.block === 'browser' && item.config.browserId === id)
})
// stamp the live URL into the pane config so a restart restores the page
browsers.on('updated', (info) => {
  const item = layout
    .items(info.projectId)
    .find((i) => i.block === 'browser' && i.config.browserId === info.id)
  if (item && item.config.url !== info.url) {
    layout.updateItemConfig(info.projectId, item.id, { ...item.config, url: info.url })
  }
})

const architecture = new ArchitectureManager()
const memory = new MemoryManager()

// project lifecycle: activation adopts panes; closing kills the project's
// sessions (its layout file survives for reopening the same folder)
projects.on('activated', (project: ProjectInfo) => {
  architecture.watch(project.id, project.path)
  void adoptPanes(project)
})
projects.on('closed', (project: ProjectInfo) => {
  workers.closeProject(project.id)
  worktrees.closeProject(project.id)
  for (const terminal of terminals.list(project.id)) terminals.close(terminal.id)
  for (const browser of browsers.list(project.id)) browsers.close(browser.id)
  architecture.unwatch(project.id)
  layout.unload(project.id)
})

// projects restored from the last session: watch them all (badges need
// their events), adopt only the active one — the rest adopt on activation.
// Adoption itself runs in whenReady: browser sessions need the app ready.
for (const project of projects.list()) architecture.watch(project.id, project.path)

const api = buildApi({
  projects,
  terminals,
  browsers,
  workers,
  worktrees,
  layout,
  blocks,
  storage,
  architecture,
  memory
})

const socketServer = startSocketServer(api)

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

projects.on('changed', (state) => broadcast('project:changed', state))
terminals.on('created', (info) => broadcast('terminal:created', info))
terminals.on('data', (event) => broadcast('terminal:data', event))
terminals.on('exit', (event) => broadcast('terminal:exit', event))
terminals.on('closed', (event) => broadcast('terminal:closed', event))
browsers.on('created', ({ info }) => broadcast('browser:created', info))
browsers.on('updated', (info) => broadcast('browser:updated', info))
browsers.on('closed', (event) => broadcast('browser:closed', event))
workers.on('created', (worker) => broadcast('worker:created', worker))
workers.on('updated', (worker) => broadcast('worker:updated', worker))
workers.on('request', (request) => broadcast('worker:request', request))
workers.on('request-resolved', (resolution) => broadcast('worker:request-resolved', resolution))
worktrees.on('request', (request) => broadcast('worktree:request', request))
worktrees.on('request-resolved', (resolution) => broadcast('worktree:request-resolved', resolution))
worktrees.on('changed', (event) => broadcast('worktree:changed', event))
layout.on('changed', (root) => broadcast('layout:changed', root))
blocks.on('changed', (list) => broadcast('blocks:changed', [...BUILTIN_BLOCK_INFOS, ...list]))
blocks.on('updated', (event) => broadcast('block:updated', event))
blocks.on('grant-request', (request) => broadcast('block:grant-request', request))
blocks.on('grant-resolved', (resolution) => broadcast('block:grant-resolved', resolution))
architecture.on('changed', (state) => broadcast('architecture:changed', state))
memory.on('updated', (event) => broadcast('memory:updated', event))

ipcMain.handle('rpc', async (_event, method: string, params: unknown) => {
  try {
    return { result: await dispatch(api, method, params, { door: 'ipc' }) }
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
      sandbox: false,
      // browser blocks embed pages in <webview> (guests stay sandboxed)
      webviewTag: true
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
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Adopt-or-spawn the PTY daemon before anything touches terminals —
  // sessions from the previous run come back through this connection
  try {
    await terminals.connect()
    // now that live sessions are known, previous-run workers come back too
    workers.rehydrate()
  } catch (error) {
    console.error('[ptyd] daemon unavailable, terminals will not work:', error)
  }

  nativeTheme.themeSource = 'dark'

  // airun9-block://bundle/<name> serves the compiled block as a standalone
  // document; the renderer embeds it in a sandboxed (null-origin) iframe
  protocol.handle('airun9-block', (request) => {
    const { pathname } = new URL(request.url)
    const name = decodeURIComponent(pathname.replace(/^\//, ''))
    try {
      return new Response(blocks.document(name), {
        headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': BLOCK_CSP }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return new Response(message, { status: 404, headers: { 'Content-Type': 'text/plain' } })
    }
  })

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

  // lazy launch restore: only the active project's panes respawn now;
  // background projects adopt on their first activation
  const restoredActive = projects.active()
  if (restoredActive) await adoptPanes(restoredActive)

  createWindow()

  // watchers + backfill of existing agent transcripts, after the window is up
  memory.start()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // Prod: detach — the daemon keeps terminals and agents alive for the next
  // launch. Dev: stop everything, or hot-reloads would leak stale-code
  // daemons (AIRUN9_PTYD_PERSIST=1 opts dev into the prod behavior).
  if (is.dev && process.env.AIRUN9_PTYD_PERSIST !== '1') terminals.shutdownDaemon()
  else terminals.detach()
  blocks.dispose()
  layout.dispose()
  architecture.dispose()
  memory.dispose()
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
