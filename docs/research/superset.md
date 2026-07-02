# Superset — Architecture Research

> Reference study of the Superset agentic IDE. Its stack matches AIRUN9's almost
> one-to-one, which validates our foundation. The value is in how it solves
> terminals, worktrees, and SSH.

## Stack validation

Superset independently chose the same stack AIRUN9 already has installed:

- electron-vite + electron-builder
- React 19, Tailwind 4 + shadcn/Radix
- zustand + TanStack Query
- tRPC over Electron IPC (`trpc-electron`)
- better-sqlite3 + Drizzle for local storage
- `@parcel/watcher` for file watching
- xterm.js + node-pty for terminals
- Native Electron `Notification` for system alerts
- Vercel AI SDK for LLM provider abstraction
- CodeMirror 6 + Shiki (not Monaco) — lighter; in an agent-first IDE the editor
  is a viewer/light-edit surface, not the main workhorse

## Key decisions worth copying

### 1. Terminals-as-a-daemon (the tmux model)

Their terminal system spans three processes:

1. Electron main process
2. A standalone PTY daemon (`@superset/pty-daemon`) communicating over Unix
   domain sockets
3. One subprocess per terminal session

The daemon owns the PTYs; the UI merely attaches/detaches. Terminal sessions
survive app restarts, crashes, and dev hot-reloads via a snapshot/handoff
protocol. Practical details they got right:

- `@xterm/headless` for server-side scrollback serialization
- WebSocket transport with write coalescing
- A cap on concurrent terminal spawns

**Build the daemon early** — "tmux-like" then falls out naturally instead of
being bolted on.

### 2. Worktrees: convention over cleverness

- Plain `simple-git` (CLI wrapper), no exotic git library
- Directory convention: `~/.superset/worktrees/<project>/<workspace>/`
- One worktree per agent task; workspace identity derived from the path
- Heavy git operations run in a worker thread (`git-task-worker.ts`) so
  large-repo scans never freeze the UI
- Multiple app instances can launch into different worktrees with separate
  SQLite databases per worktree

### 3. SSH: don't build it, borrow it

No SSH library at all. Terminals inherit the system's OpenSSH with
`SSH_AUTH_SOCK` forwarded into the PTY environment — `ssh`, agent auth, and
remote sessions just work inside their terminals. Only reach for `ssh2` later
if programmatic remote file access is needed. SSH is a thing terminals can
run, not a subsystem to own (see Orca research for the next level of this).

### 4. Agents via shell wrappers, not embedded SDKs

Shell wrappers and hook configs are injected into terminal environments so any
CLI agent (Claude Code, Codex, Gemini, Cursor, …) runs inside managed
terminals; an orchestrator manages session lifecycles, MCP handles tool
integration. For AIRUN9's own in-app agent (the one that builds/edits the UI),
an in-process agent (Vercel AI SDK / Claude Agent SDK) with our API as its
tools is still the right shape — the wrapper approach is for the development
agents users run.

### 5. Layout as data

They built a custom headless panes engine (`@superset/panes`) plus
react-mosaic for terminal grids. For a dynamic "blocks" concept the headless
engine is the aligned end-state: layout state stays pure data (which an agent
can edit) and rendering is separate. Pragmatic path: start with dockview to
move fast, but keep layout state serialized in our own schema so the renderer
can be swapped later.

## Smaller notes

- Toolchain: Turborepo + Bun + Biome (monorepo makes sense once a CLI or web
  companion exists; single-app repo is fine to start)
- Notification sounds: files unpacked from ASAR, played via `afplay` on macOS
  (Electron's `sound:` option only takes system sound names)
- Sentry + electron-updater + PostHog for crash reporting, auto-update,
  analytics
