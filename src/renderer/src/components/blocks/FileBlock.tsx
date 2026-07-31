import { useEffect, useState } from 'react'
import { IconRefresh } from '@tabler/icons-react'
import { type BundledLanguage, codeToHtml } from 'shiki'
import type { FileReadResult } from '../../../../shared/types'
import { api } from '../../lib/api'
import type { BlockPaneProps } from './registry'

/**
 * Built-in file reader: renders one project file (fs.read) as a real layout
 * pane. The files block opens it with `config.path` and retargets it via
 * layout.updateItem when another file is clicked. Content is highlighted
 * with shiki (grammar lazy-loads per language); plain text shows first so
 * the file is readable before highlighting lands.
 */

/** skip highlighting above this many chars — keep huge files snappy */
const HIGHLIGHT_CAP = 200_000

const EXT_LANG: Record<string, BundledLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  xml: 'xml',
  svg: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  diff: 'diff',
  ini: 'ini',
  prisma: 'prisma',
  tf: 'terraform',
  dockerfile: 'docker'
}

const FILENAME_LANG: Record<string, BundledLanguage> = {
  dockerfile: 'docker',
  makefile: 'makefile'
}

function languageFor(path: string): BundledLanguage | null {
  const base = (path.split('/').pop() ?? '').toLowerCase()
  const byName = FILENAME_LANG[base]
  if (byName) return byName
  const dot = base.lastIndexOf('.')
  if (dot < 0) return null
  return EXT_LANG[base.slice(dot + 1)] ?? null
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface LoadState {
  path: string
  file: FileReadResult | null
  error: string | null
}

function FileBlock({ config }: BlockPaneProps): React.JSX.Element {
  const path = typeof config.path === 'string' ? config.path : ''
  const [state, setState] = useState<LoadState>({ path: '', file: null, error: null })
  const [highlighted, setHighlighted] = useState<{ path: string; html: string } | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!path) return
    let alive = true
    void api
      .readFile(path)
      .then((file) => {
        if (alive) setState({ path, file, error: null })
      })
      .catch((e) => {
        if (alive) setState({ path, file: null, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      alive = false
    }
  }, [path, tick])

  // highlight after the raw content is already on screen
  useEffect(() => {
    const { path: loadedPath, file } = state
    if (!file || file.binary || !file.content || file.content.length > HIGHLIGHT_CAP) return
    const lang = languageFor(loadedPath)
    if (!lang) return
    let alive = true
    void codeToHtml(file.content, { lang, theme: 'one-dark-pro' })
      .then((html) => {
        if (alive) setHighlighted({ path: loadedPath, html })
      })
      .catch((e) => {
        // unknown grammar or highlight failure — the plain view stays
        console.error('file: highlight failed:', e)
      })
    return () => {
      alive = false
    }
  }, [state])

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-neutral-600">
        No file selected
      </div>
    )
  }

  // config changed but the new content hasn't arrived yet
  const loading = state.path !== path
  const { file, error } = state
  const html = !loading && highlighted?.path === path ? highlighted.html : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="truncate text-[12px] text-neutral-200">{path}</span>
        {!loading && file && (
          <span className="shrink-0 text-[11px] text-neutral-600">
            {formatSize(file.size)}
            {file.truncated ? ' · showing first 256 KB' : ''}
          </span>
        )}
        <button
          type="button"
          title="Reload file"
          onClick={() => setTick((t) => t + 1)}
          className="ml-auto rounded-md p-1 text-neutral-500 transition-colors hover:bg-white/[0.08] hover:text-neutral-100"
        >
          <IconRefresh className="size-3.5" stroke={1.75} />
        </button>
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-neutral-600">
          Loading…
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[12px] text-red-400/80">
          {error}
        </div>
      ) : file?.binary ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-neutral-600">
          Binary file
        </div>
      ) : html ? (
        <div
          className="min-h-0 w-full flex-1 overflow-y-auto p-3 text-[11px] leading-relaxed [&_code]:font-mono [&_pre]:bg-transparent! [&_pre]:break-words [&_pre]:whitespace-pre-wrap"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="min-h-0 w-full flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-neutral-300">
          {file?.content}
        </pre>
      )}
    </div>
  )
}

export default FileBlock
