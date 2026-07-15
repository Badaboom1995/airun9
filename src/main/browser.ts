import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { app, session, webContents, type WebContents } from 'electron'
import { nanoid } from 'nanoid'
import { BROWSER_PARTITION, type BrowserInfo, type PanePosition } from '../shared/types'

/**
 * Owns every embedded browser page (ADR-0008 shape: main owns the resource,
 * the renderer shows it, users and agents drive it through the same API).
 * The page itself renders in a <webview> the BrowserBlock mounts; the guest
 * WebContents is adopted here via browser.attach, which is what lets agents
 * navigate/screenshot/read pages over the socket.
 */

const CONSOLE_CHARS = 256 * 1024
const TEXT_CAP = 200_000
const DEFAULT_URL = 'https://www.google.com'

/**
 * Exactly what real Chrome sends. Google refuses sign-in from UAs it
 * classifies as embedded browsers, and it also flags *fake* Chrome UAs:
 * since UA reduction, every real Chrome reports the frozen form
 * `Chrome/<major>.0.0.0` (and a frozen OS string) — merely stripping the
 * Electron token leaves the full Chromium version in place, which no real
 * Chrome ever sends. So we construct the reduced UA instead of editing
 * Electron's.
 */
function chromeUserAgent(): string {
  const major = (process.versions.chrome ?? '142').split('.')[0]
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

export interface CreateBrowserOptions {
  /** Project whose workspace gets the pane */
  projectId: string
  url?: string
  position?: PanePosition
}

interface ManagedBrowser {
  info: BrowserInfo
  wc: WebContents | null
  console: string
}

/** Loose address-bar input → loadable URL (scheme, localhost, or web search) */
export function normalizeUrl(input: string): string {
  const raw = input.trim()
  if (raw === '') return DEFAULT_URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw
  // dev servers are http; everything else defaults to https
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/.test(raw)) {
    return `http://${raw}`
  }
  if (/^\S+\.\S+/.test(raw)) return `https://${raw}`
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}

export class BrowserManager extends EventEmitter {
  private browsers = new Map<string, ManagedBrowser>()
  private sessionReady = false

  constructor() {
    super()
    // localhost dev servers often run self-signed TLS; never relax for the web
    app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
      const host = new URL(url).hostname
      const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
      if (local) event.preventDefault()
      callback(local)
    })
  }

  create(options: CreateBrowserOptions): BrowserInfo {
    this.ensureSession()
    const info: BrowserInfo = {
      id: `browser_${nanoid(10)}`,
      projectId: options.projectId,
      url: normalizeUrl(options.url ?? DEFAULT_URL),
      title: '',
      favicon: null,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      createdAt: Date.now()
    }
    this.browsers.set(info.id, { info, wc: null, console: '' })
    this.emit('created', { info, position: options.position ?? 'tab' })
    return info
  }

  /** Adopt the guest WebContents of the block's <webview> (renderer-reported) */
  attach(id: string, webContentsId: number): BrowserInfo {
    const managed = this.managed(id)
    if (managed.wc && !managed.wc.isDestroyed() && managed.wc.id === webContentsId) {
      return managed.info
    }
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) throw new Error(`No such webContents: ${webContentsId}`)
    if (wc.getType() !== 'webview') throw new Error('browser.attach only accepts webview guests')
    managed.wc = wc
    this.wire(managed, wc)
    // events that fired before adoption (title, first navigation) are gone —
    // pull the current state instead of waiting for the next ones
    Object.assign(managed.info, {
      url: wc.getURL() || managed.info.url,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    })
    this.emit('updated', managed.info)
    return managed.info
  }

  list(projectId?: string): BrowserInfo[] {
    const all = [...this.browsers.values()].map((b) => b.info)
    return projectId ? all.filter((b) => b.projectId === projectId) : all
  }

  get(id: string): BrowserInfo {
    return this.managed(id).info
  }

  navigate(id: string, url: string): BrowserInfo {
    const managed = this.managed(id)
    const normalized = normalizeUrl(url)
    managed.info.url = normalized
    // no wc yet (block still mounting) is fine: the webview loads info.url
    managed.wc?.loadURL(normalized).catch(() => {})
    this.emit('updated', managed.info)
    return managed.info
  }

  back(id: string): void {
    this.attached(id).navigationHistory.goBack()
  }

  forward(id: string): void {
    this.attached(id).navigationHistory.goForward()
  }

  reload(id: string): void {
    this.attached(id).reload()
  }

  stop(id: string): void {
    this.attached(id).stop()
  }

  /** PNG of the current viewport; written to `path` when given (agents Read it) */
  async screenshot(
    id: string,
    path?: string
  ): Promise<{ path?: string; dataUrl?: string; width: number; height: number }> {
    const image = await this.attached(id).capturePage()
    const { width, height } = image.getSize()
    if (path) {
      writeFileSync(path, image.toPNG())
      return { path, width, height }
    }
    return { dataUrl: image.toDataURL(), width, height }
  }

  /** Rendered text of the page, for agents that want content, not pixels */
  async text(
    id: string
  ): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
    const wc = this.attached(id)
    const raw = (await wc.executeJavaScript(
      'document.body ? document.body.innerText : ""',
      true
    )) as string
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      text: raw.slice(0, TEXT_CAP),
      truncated: raw.length > TEXT_CAP
    }
  }

  /** Tail of the page's console output (the agent debug loop for previews) */
  console(id: string, tailChars = 20_000): { data: string } {
    return { data: this.managed(id).console.slice(-tailChars) }
  }

  close(id: string): void {
    const managed = this.managed(id)
    this.browsers.delete(id)
    // the layout item removal unmounts the webview, which destroys the guest
    this.emit('closed', { id, projectId: managed.info.projectId })
  }

  private ensureSession(): void {
    if (this.sessionReady) return
    this.sessionReady = true
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    browserSession.setUserAgent(chromeUserAgent())
    browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write')
    })
  }

  private wire(managed: ManagedBrowser, wc: WebContents): void {
    const update = (patch: Partial<BrowserInfo>): void => {
      Object.assign(managed.info, patch)
      this.emit('updated', managed.info)
    }
    const syncNav = (): void => {
      if (wc.isDestroyed()) return
      update({
        url: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
    }

    wc.on('did-start-loading', () => update({ loading: true }))
    wc.on('did-stop-loading', () => {
      update({ loading: false })
      syncNav()
    })
    wc.on('did-navigate', syncNav)
    wc.on('did-navigate-in-page', syncNav)
    wc.on('page-title-updated', (_event, title) => update({ title }))
    wc.on('page-favicon-updated', (_event, favicons) => {
      // sites without a favicon report the empty 'data:,' — not renderable
      const favicon = favicons.find((f) => f !== 'data:,') ?? null
      update({ favicon })
    })
    wc.on('console-message', (event) => {
      const line = `[${event.level}] ${event.message}\n`
      managed.console = (managed.console + line).slice(-CONSOLE_CHARS)
    })
    // popups become sibling browser blocks instead of OS windows,
    // in the same project as the page that opened them
    wc.setWindowOpenHandler(({ url }) => {
      this.create({ projectId: managed.info.projectId, url })
      return { action: 'deny' }
    })
    wc.on('destroyed', () => {
      if (managed.wc === wc) managed.wc = null
    })
  }

  private managed(id: string): ManagedBrowser {
    const browser = this.browsers.get(id)
    if (!browser) throw new Error(`Unknown browser: ${id}`)
    return browser
  }

  private attached(id: string): WebContents {
    const { wc } = this.managed(id)
    if (!wc || wc.isDestroyed()) throw new Error(`Browser ${id} has no attached page yet`)
    return wc
  }
}
