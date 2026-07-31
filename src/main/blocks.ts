import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import './esbuild-env'
import type { BlockGrantRequest, BlockInfo, BlockManifest } from '../shared/types'

export const BLOCKS_DIR = join(homedir(), '.airun9', 'blocks')

/**
 * CSP for block documents served over airun9-block://. Blocks get their own
 * policy instead of inheriting the app page's (which forbids inline scripts
 * and killed srcdoc-hosted blocks); the iframe sandbox keeps them null-origin.
 */
export const BLOCK_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"

/** Built-in blocks, listed alongside custom ones so callers see one catalog */
export const BUILTIN_BLOCK_INFOS: BlockInfo[] = [
  {
    name: 'hello',
    manifest: { name: 'hello', title: 'Hello', capabilities: [] },
    error: null,
    builtin: true
  },
  {
    name: 'workers',
    manifest: { name: 'workers', title: 'Workers', capabilities: [] },
    error: null,
    builtin: true
  },
  {
    name: 'projects',
    manifest: { name: 'projects', title: 'Projects', capabilities: [] },
    error: null,
    builtin: true
  },
  {
    name: 'architecture',
    manifest: { name: 'architecture', title: 'Architecture', capabilities: [] },
    error: null,
    builtin: true
  },
  {
    name: 'files',
    manifest: { name: 'files', title: 'Files', capabilities: [] },
    error: null,
    builtin: true
  },
  {
    name: 'browser',
    manifest: { name: 'browser', title: 'Browser', capabilities: [] },
    error: null,
    builtin: true
  }
]

/**
 * Methods any block may call once declared, without a user grant (ADR-0004):
 * reading is free, and storage.* only touches the block's own namespace.
 */
const AUTO_GRANTED_METHODS = new Set([
  'storage.get',
  'storage.set',
  'app.ping',
  'project.get',
  'architecture.get',
  'fs.list',
  'fs.read',
  'terminal.list',
  'terminal.get',
  'terminal.read',
  'terminal.snapshot',
  'worker.list',
  'worker.get',
  'worker.read',
  'worker.result',
  'worker.wait',
  'layout.get',
  'block.list',
  // list/get expose only page metadata; text/screenshot/console expose the
  // content of the user's logged-in pages, so those need an explicit grant
  'browser.list',
  'browser.get'
])

interface CompiledBlock {
  info: BlockInfo
  code: string | null
}

interface PendingGrant {
  request: BlockGrantRequest
  resolve: (granted: boolean) => void
}

/**
 * Watches ~/.airun9/blocks/<name>/{block.json,index.tsx}, compiles each
 * block to a self-contained bundle (own React, SDK inlined), and gates its
 * declared capabilities: read-only methods auto-grant, mutating ones need
 * a one-time user approval per session (ADR-0003 tier 3/4 — user- and
 * agent-authored blocks are sandboxed and capability-scoped alike).
 */
export class BlocksManager extends EventEmitter {
  private blocks = new Map<string, CompiledBlock>()
  private grants = new Map<string, boolean>()
  private pendingGrants = new Map<string, PendingGrant>()
  private watcher: FSWatcher | null = null
  private rescanTimer: NodeJS.Timeout | null = null

  constructor(
    private sdkPath: string,
    private nodeModulesDir: string
  ) {
    super()
    mkdirSync(BLOCKS_DIR, { recursive: true })
    void this.rescan()
    try {
      this.watcher = watch(BLOCKS_DIR, { recursive: true }, () => {
        // debounce bursts of fs events into one rescan
        if (this.rescanTimer) clearTimeout(this.rescanTimer)
        this.rescanTimer = setTimeout(() => void this.rescan(), 200)
      })
    } catch (error) {
      console.error('blocks watcher failed:', error)
    }
  }

  list(): BlockInfo[] {
    return [...this.blocks.values()].map((b) => b.info)
  }

  bundle(name: string): { code: string; manifest: BlockManifest } {
    const block = this.blocks.get(name)
    if (!block) throw new Error(`Unknown block: ${name}`)
    if (block.code === null) throw new Error(block.info.error ?? `Block ${name} failed to build`)
    return { code: block.code, manifest: block.info.manifest }
  }

  /** Full HTML document for a block iframe, served via airun9-block:// */
  document(name: string): string {
    const { code } = this.bundle(name)
    const safe = code.replace(/<\/script/gi, '<\\/script')
    return (
      '<!doctype html><html><head>' +
      '<style>body{margin:0;background:#0b0e0c;color:#d6d8d6;font:13px ui-sans-serif,system-ui}</style>' +
      '</head><body><div id="root"></div>' +
      `<script>${safe}</script></body></html>`
    )
  }

  /**
   * Resolve which of the block's declared capabilities it may use.
   * Read-only ones pass silently; mutating ones require the user's one-time
   * approval (in-app dialog), remembered for the session.
   */
  async grant(name: string): Promise<{ granted: string[] }> {
    const block = this.blocks.get(name)
    if (!block) throw new Error(`Unknown block: ${name}`)
    const capabilities = block.info.manifest.capabilities ?? []
    const mutating = capabilities.filter((c) => !AUTO_GRANTED_METHODS.has(c))
    if (mutating.length === 0) return { granted: capabilities }

    if (this.grants.get(name) === undefined) {
      const approved = await new Promise<boolean>((resolve) => {
        const request: BlockGrantRequest = {
          id: `grant_${nanoid(8)}`,
          blockName: name,
          title: block.info.manifest.title ?? name,
          capabilities: mutating
        }
        this.pendingGrants.set(request.id, { request, resolve })
        this.emit('grant-request', request)
      })
      this.grants.set(name, approved)
    }

    return this.grants.get(name)
      ? { granted: capabilities }
      : { granted: capabilities.filter((c) => AUTO_GRANTED_METHODS.has(c)) }
  }

  pendingGrantRequests(): BlockGrantRequest[] {
    return [...this.pendingGrants.values()].map((p) => p.request)
  }

  resolveGrant(requestId: string, approved: boolean): void {
    const pending = this.pendingGrants.get(requestId)
    if (!pending) throw new Error(`Unknown grant request: ${requestId}`)
    this.pendingGrants.delete(requestId)
    this.emit('grant-resolved', { requestId, approved })
    pending.resolve(approved)
  }

  dispose(): void {
    this.watcher?.close()
  }

  private async rescan(): Promise<void> {
    const names = existsSync(BLOCKS_DIR)
      ? readdirSync(BLOCKS_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
      : []

    for (const stale of [...this.blocks.keys()]) {
      if (!names.includes(stale)) this.blocks.delete(stale)
    }
    await Promise.all(names.map((name) => this.compile(name)))
    this.emit('changed', this.list())
  }

  private async compile(name: string): Promise<void> {
    const dir = join(BLOCKS_DIR, name)
    const entry = join(dir, 'index.tsx')
    let manifest: BlockManifest = { name, capabilities: [] }
    try {
      if (!existsSync(entry)) throw new Error('missing index.tsx')
      const manifestPath = join(dir, 'block.json')
      if (existsSync(manifestPath)) {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<BlockManifest>
        manifest = {
          name,
          title: parsed.title,
          capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : []
        }
      }

      // the boundary keeps a crashing block visible (error text) instead of
      // React silently unmounting to a blank pane
      const wrapper = `
        import Component from './index.tsx'
        import { Component as ReactComponent, createElement } from 'react'
        import { createRoot } from 'react-dom/client'
        import { __connect } from 'airun9'
        class Boundary extends ReactComponent {
          state = { error: null }
          static getDerivedStateFromError(error) { return { error } }
          render() {
            if (this.state.error === null) return this.props.children
            const message = this.state.error?.message ?? String(this.state.error)
            return createElement(
              'div',
              { style: { padding: 16, color: '#e08a7a', fontSize: 12, whiteSpace: 'pre-wrap' } },
              'Block crashed: ' + message
            )
          }
        }
        __connect().then(() => {
          createRoot(document.getElementById('root')).render(
            createElement(Boundary, null, createElement(Component))
          )
        })
      `
      // dynamic so esbuild loads after esbuild-env.ts has set
      // ESBUILD_BINARY_PATH — a static import gets hoisted above it by the
      // bundler and esbuild snapshots the variable at module load
      const { build } = await import('esbuild')
      const result = await build({
        stdin: { contents: wrapper, resolveDir: dir, loader: 'tsx' },
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        jsx: 'automatic',
        alias: { airun9: this.sdkPath },
        nodePaths: [this.nodeModulesDir],
        define: { 'process.env.NODE_ENV': '"production"' },
        minify: true,
        logLevel: 'silent'
      })

      const previous = this.blocks.get(name)
      const code = result.outputFiles[0].text
      this.blocks.set(name, { info: { name, manifest, error: null }, code })
      if (previous?.code !== code) this.emit('updated', { name })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.blocks.set(name, { info: { name, manifest, error: message }, code: null })
      this.emit('updated', { name })
    }
  }
}
