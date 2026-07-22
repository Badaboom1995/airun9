// Shared contracts between main, preload, renderer and the socket API.
// One dispatcher, many doors (ADR-0008): every door speaks these shapes.

export type TerminalStatus = 'running' | 'exited'

export interface TerminalInfo {
  id: string
  /** Project this terminal belongs to; agents inside operate on it */
  projectId: string
  title: string
  cwd: string
  cols: number
  rows: number
  status: TerminalStatus
  exitCode: number | null
  /** Set when this terminal is owned by a Worker */
  workerId: string | null
  createdAt: number
}

export interface WorkerInfo {
  id: string
  projectId: string
  name: string
  prompt: string
  terminalId: string
  kind: WorkerKind
  mode: WorkerMode
  location: WorkerLocation
  /** Directory the worker runs in (project dir or its worktree) */
  cwd: string
  /**
   * running — agent is working on a turn
   * done — agent finished its turn and is idle (keep-alive; can be prompted)
   * exited — process is gone (stopped or crashed)
   */
  status: WorkerStatus
  exitCode: number | null
  /** Claude Code transcript (JSONL), reported by the Stop hook */
  transcriptPath: string | null
  createdAt: number
}

export type WorkerKind = 'scout' | 'full'
/** plan = read-only research; manual = user answers permission prompts in the tab */
export type WorkerMode = 'plan' | 'bypass' | 'edits' | 'manual'
export type WorkerLocation = 'shared' | 'worktree'
export type WorkerStatus = 'running' | 'done' | 'exited'

/** A pending "spawn full worker" approval shown to the user in the app */
export interface WorkerRequest {
  id: string
  /** Captured when the request is made — approval spawns into THIS project,
   * regardless of which project is active when the user decides */
  projectId: string
  prompt: string
  name: string | null
  count: number
  reason: string | null
  recommendedMode: Exclude<WorkerMode, 'plan'>
  recommendedLocation: WorkerLocation
  createdAt: number
}

export interface WorkerRequestDecision {
  requestId: string
  approved: boolean
  mode: Exclude<WorkerMode, 'plan'>
  location: WorkerLocation
  /** Spawn into this EXISTING worktree instead of creating a fresh one
   * (only meaningful with location 'worktree') */
  worktreeId?: string
}

/**
 * A git worktree of a project (ADR-0011): a first-class resource. Git is the
 * source of truth — this shape is a parsed `git worktree list` entry, never a
 * stored record. The main checkout is the first, unremovable entry.
 */
export interface WorktreeInfo {
  /** Deterministic hash of the path (like project ids) — stable across scans */
  id: string
  projectId: string
  /** Directory basename; the main checkout reports the project name */
  name: string
  path: string
  /** Checked-out branch, null when detached */
  branch: string | null
  /** Short HEAD sha */
  head: string
  /** The repo's main checkout (the project folder itself) */
  isMain: boolean
  /** Lives outside ~/.airun9/worktrees (made by hand with plain git) */
  external: boolean
}

/** Pending "create worktree(s)" approval (agents only; the UI dialog IS the
 * user's consent and creates directly) */
export interface WorktreeCreateRequest {
  kind: 'create'
  id: string
  projectId: string
  /** Final names — one worktree each */
  names: string[]
  /** Branches to create, airun9/<name> */
  branches: string[]
  /** Base commit resolved at request time — what the approval card shows is
   * exactly what gets used, even if HEAD moves before the user decides */
  base: string
  /** Human label for the card: "main @ 40cc61a" */
  baseLabel: string
  reason: string | null
  createdAt: number
}

/** Pending "remove worktree" approval, with the blast radius computed at
 * request time (ADR-0004: destructive ops always confirm) */
export interface WorktreeRemoveRequest {
  kind: 'remove'
  id: string
  projectId: string
  worktreeId: string
  name: string
  path: string
  branch: string | null
  external: boolean
  /** Uncommitted changes that die with the tree */
  dirtyFiles: number
  /** Commits on the branch not reachable from the main checkout's HEAD —
   * they survive unless the user also deletes the branch */
  aheadCommits: number
  /** Live workers inside — approval stops them */
  workerCount: number
  /** Live non-worker terminals inside — approval closes them */
  terminalCount: number
  reason: string | null
  createdAt: number
}

export type WorktreeRequest = WorktreeCreateRequest | WorktreeRemoveRequest

export interface WorktreeRequestDecision {
  requestId: string
  approved: boolean
  /** Remove only: also delete the local branch (unmerged commits die too) */
  deleteBranch?: boolean
}

/** What a resolved create request returns to the requesting agent */
export interface WorktreeCreateResult {
  worktrees: WorktreeInfo[]
  /** The project's remembered bootstrap command — a suggestion, not a
   * promise: the agent decides what to actually run in the new tree */
  bootstrapCmd: string | null
}

/**
 * An open project (a folder, usually a repo). Several can be open at once;
 * each owns its layout tree, terminals, browsers and agents. `id` is derived
 * deterministically from the realpath, so closing and reopening a folder
 * finds its persisted layout again.
 */
export interface ProjectInfo {
  id: string
  path: string
  name: string
  /** Reserved for worktrees: a worktree is a child workspace of its repo */
  parentId: string | null
  createdAt: number
}

/** project:changed payload: the full switcher state */
export interface ProjectsState {
  projects: ProjectInfo[]
  activeId: string | null
}

/**
 * Scrollback snapshot. `seq` is the cumulative count of characters the
 * terminal has ever emitted; data events carry the same counter so a client
 * can replay the snapshot and then apply only events with seq > snapshot.seq.
 */
export interface TerminalSnapshot {
  info: TerminalInfo
  data: string
  seq: number
}

export interface TerminalDataEvent {
  id: string
  data: string
  /** Cumulative char count after this chunk was appended */
  seq: number
}

export interface TerminalExitEvent {
  id: string
  exitCode: number
}

/**
 * An embedded browser page (one page per block; pane tabs are the browser
 * tabs). Sessions share the persistent `persist:airun9-browser` partition,
 * so logins survive restarts and are common to all browser blocks.
 */
export interface BrowserInfo {
  id: string
  projectId: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  createdAt: number
}

/**
 * Layout is pure serialized data (ADR-0001): a split tree whose leaves are
 * tab groups of block instances. Main owns it; renderer renders it; agents
 * edit it via layout.get/set.
 */
export interface LayoutTabItem {
  id: string
  /** block type in the registry: 'terminal', 'custom', ... */
  block: string
  config: Record<string, unknown>
}

export interface TabsNode {
  type: 'tabs'
  id: string
  active: string | null
  /** The workspace's main group: new 'tab'-position panes land here and the
   * +terminal/+browser controls render here. Stable across structural edits —
   * opening a panel to the LEFT must not steal either (it used to: both
   * followed "first group in tree order"). */
  primary?: boolean
  items: LayoutTabItem[]
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: 'row' | 'column'
  /** one entry per child, sums to ~1 */
  ratios: number[]
  children: LayoutNode[]
}

export type LayoutNode = TabsNode | SplitNode

/** layout:changed payload — trees are per-project */
export interface LayoutChangedEvent {
  projectId: string
  root: LayoutNode
}

/** Where block.open places a new pane */
export type PanePosition = 'tab' | 'right' | 'down' | 'left' | 'up'

/** Built-in block types that block.open can instantiate directly (no bundle) */
export const BUILTIN_OPENABLE_BLOCKS = [
  'hello',
  'workers',
  'projects',
  'architecture',
  'files'
] as const

/** block.open('browser') routes through browser.create instead (needs a session) */
export const BROWSER_BLOCK = 'browser'

/** One persistent profile shared by all browser blocks (logins survive restarts) */
export const BROWSER_PARTITION = 'persist:airun9-browser'

/** One fs.list entry; `path` is project-relative with '/' separators */
export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  /** bytes; null for directories */
  size: number | null
}

/** fs.read result; `content` is empty when the file is binary */
export interface FileReadResult {
  path: string
  content: string
  /** full size on disk, even when truncated */
  size: number
  truncated: boolean
  binary: boolean
}

/** Manifest of a user/agent-authored block (~/.airun9/blocks/<name>/block.json) */
export interface BlockManifest {
  name: string
  title?: string
  /** API methods the block may call; undeclared methods are always denied */
  capabilities: string[]
}

export interface BlockInfo {
  name: string
  manifest: BlockManifest
  /** compile error, if the last build failed */
  error: string | null
  /** ships with the app (no folder in ~/.airun9/blocks) */
  builtin?: boolean
}

/** Pending "grant this block its capabilities" decision */
export interface BlockGrantRequest {
  id: string
  blockName: string
  title: string
  /** the mutating subset that needs explicit approval */
  capabilities: string[]
}

/**
 * Architecture schema: agent-maintained map of the open project's modules,
 * stored in the repo at .airun9/architecture.json so it is git-versioned and
 * per-project. Main watches the file; the architecture block renders it.
 * Loosely validated — unknown fields pass through so agents can extend it.
 */
export interface ArchGroup {
  id: string
  title: string
}

export interface ArchModule {
  id: string
  title: string
  /** repo-relative path, lets tooling recompute loc later */
  path?: string
  /** ArchGroup id; ungrouped modules land in an implicit "other" column */
  group?: string
  loc?: number
  summary?: string
}

export interface ArchEdge {
  from: string
  to: string
  label?: string
}

export interface ArchitectureSchema {
  version: number
  updatedAt?: string
  groups?: ArchGroup[]
  modules: ArchModule[]
  edges?: ArchEdge[]
}

/** What architecture.get returns and architecture:changed carries */
export interface ArchitectureState {
  /** project the schema belongs to, null if none open */
  projectId: string | null
  /** that project's root path */
  project: string | null
  /** null when the file is missing or invalid */
  schema: ArchitectureSchema | null
  /** set when the file exists but failed to parse/validate */
  error: string | null
}

/** Agent CLIs whose transcripts feed the memory DB */
export type MemoryAgent = 'claude' | 'gpt' | 'grok'

export type MemoryRole = 'user' | 'assistant' | 'tool'

export interface MemorySessionInfo {
  /** `<agent>:<native session id>` — unique across agents */
  id: string
  agent: MemoryAgent
  /** the id the agent CLI itself uses for this session */
  nativeId: string
  /** working directory the session ran in, null if unknown */
  cwd: string | null
  /** source transcript file the messages were ingested from */
  file: string
  startedAt: number | null
  updatedAt: number | null
  messageCount: number
}

export interface MemoryMessage {
  id: number
  sessionId: string
  /** position within the session, 0-based */
  ordinal: number
  role: MemoryRole
  content: string
  /** set on role "tool": which tool was called / produced the result */
  toolName: string | null
  ts: number | null
}

export interface MemorySearchHit {
  messageId: number
  sessionId: string
  agent: MemoryAgent
  cwd: string | null
  role: MemoryRole
  toolName: string | null
  ts: number | null
  /** FTS match snippet with the surrounding context */
  snippet: string
}

/** Renderer push channels (webContents.send) */
export const EVENT_CHANNELS = [
  'project:changed',
  'terminal:created',
  'terminal:data',
  'terminal:exit',
  'terminal:closed',
  'worker:created',
  'worker:updated',
  'worker:request',
  'worker:request-resolved',
  'worktree:request',
  'worktree:request-resolved',
  'worktree:changed',
  'browser:created',
  'browser:updated',
  'browser:closed',
  'layout:changed',
  'blocks:changed',
  'block:updated',
  'block:grant-request',
  'block:grant-resolved',
  'architecture:changed',
  'memory:updated'
] as const

export type EventChannel = (typeof EVENT_CHANNELS)[number]

export interface RpcResponse {
  result?: unknown
  error?: { message: string }
}

/** The preload bridge exposed to the renderer as `window.api` */
export interface Airun9Bridge {
  rpc(method: string, params?: unknown): Promise<RpcResponse>
  pickDirectory(): Promise<string | null>
  /** Subscribe to a push channel; returns an unsubscribe function */
  on(channel: EventChannel, callback: (payload: unknown) => void): () => void
}
