# AIRUN9 — v1 Build Plan (execution brief)

This is the handoff brief for building v1. Read the ADRs in `docs/adr/` and
`docs/glossary.md` first — they define *what and why*. This file defines
*the order to build and what "done" means* for each step.

**Ground rules for the executing agent**
- Follow the glossary vocabulary exactly: Project, Worker, Layout, Block.
- Everything a block/action/agent does goes through the internal API
  (capability-scoped, ADR-0004). No block touches git/fs/pty directly.
- Layout is serialized data (ADR-0001). No layout state hidden in component
  state.
- Build built-in features *as blocks over the public API* (dogfood): if a
  built-in block can't be built on the API, the API is wrong.
- Stack is already installed (see package.json): electron-vite, React 19,
  Tailwind 4 + shadcn, zustand, TanStack Query, trpc-electron, better-sqlite3
  + Drizzle (ADR-0010), @parcel/watcher, xterm.js + node-pty, CodeMirror 6.
- Current app is welcome-screen-only (`src/renderer/src/components/Welcome.tsx`
  + `SpaceShader.tsx`). Keep the welcome screen reachable but build the
  workspace as the main surface.
- Commit per step on branches off `main`; typecheck must pass
  (`npm run typecheck`) before each commit.

---

## Step 1 — API spine + block registry + layout shell

The foundation; ADRs 0003/0004/0006/0008 all assume it exists.

- **Internal API (main process):** a tRPC router (trpc-electron) organized by
  capability domain (`fs`, `git`, `terminal`, `worker`, `layout`, `project`,
  see ADR-0004 table). Start with `project.*` and `layout.*`. Add a
  capability-check + audit-log middleware seam now, even if permissive in v1.
- **Block registry:** a block = `{ type, configSchema (zod), component }`.
  Central registry maps type → definition. Renderer instantiates blocks from
  serialized `{ type, config }` with zod validation + an error boundary per
  pane.
- **Layout shell:** tiled panes (splits + tabs) rendered from a serialized
  layout tree in the zustand store; one global layout (ADR-0002). Start with
  a simple JSON schema `{ tabs: [...], splits: [...] }`; a headless engine can
  come later. Support a `floating` block flag (overlay portal).
- **First trivial blocks** to prove the loop: a "hello" block and a
  `project-info` block reading `project.get` over the API.

**Done when:** the app opens a workspace showing a tiled layout built from
JSON, blocks render via the registry, and one block gets its data through a
tRPC call routed through the capability/audit middleware.

## Step 2 — PTY daemon + terminal block

Hardest infra; everything agent-shaped sits inside it. Model: Superset/Orca
detached daemon (see docs/research). Build early or rebuild later.

- Detached PTY daemon process owning node-pty subprocesses; renderer
  attaches/detaches over a local socket. Sessions survive renderer reload and
  app restart (snapshot/handoff).
- Scrollback survives restart via `@xterm/headless` + serialize addon.
- Terminal block: xterm.js with fit + webgl addons. Quality bar (ADR-0009):
  no glitching, correct resize, easy selection/copy.
- Terminal UX: multiple terminal tabs; within one tab, tmux-style splits.
- Expose via API: `terminal.create/list/read/write` (ADR-0004 capabilities).

**Done when:** multiple terminals run in tabs with splits, survive an app
restart with scrollback intact, and are all driven through `terminal.*` API.

## Step 3 — Workers + public local API

- **Worker** = worktree + agent session + terminals behind one concept
  (ADR-0002). `worker.create` makes a git worktree (simple-git or shell),
  launches the chosen CLI agent (default configurable, ADR-0007) in a
  terminal. `worker.list/get/stop`. Concurrency cap (~4).
- **Public local API (ADR-0008):** serve the same API over a Unix socket.
  Ship the `airun9` CLI (injected into managed terminals' PATH with a scoped
  token) and an MCP server exposing `worker_create`, `worker_list`,
  `worker_status`, etc.
- **Status board block:** lists Workers + state, over `worker.list`.
- Agent pool: `worker.list`/`terminal.list` enumerable so an agent can report
  what's running.

**Done when:** a Worker can be created from UI *and* by a CLI agent running
`airun9 worker create --count 3 --prompt "…"`; the status board shows all
three; each runs its agent in an isolated worktree.

## Step 4 — File tree, editor, diff/merge blocks

Closes the review-and-integrate loop (ADR-0006).

- File tree block (over `fs.read`, path-scoped to the Project). @parcel/watcher
  for live updates.
- Editor block: CodeMirror 6 (viewer / light edit).
- Diff block: combined diff of a Worker's branch vs its base.
- Merge/discard actions: `git.commitAndPush` / squash-merge / cleanup worktree,
  with destructive-op confirmation (ADR-0004). Human flow only in v1, but the
  API shaped so an agent can drive it later.

**Done when:** the v1 demo works end to end — tell a CLI agent "run 3 workers
on this task", watch the status board, review each Worker's diff, merge the
winner.

---

## The v1 demo (definition of v1 success)

> User tells their Claude agent (running in an AIRUN9 terminal): "I want dark
> mode for my app — run 3 workers, I'll pick who did best." The agent calls
> the public API; 3 Workers spin up, each a Claude agent in its own worktree.
> The status board shows them working. The user reviews the three diffs and
> merges the winner. All UI is blocks over the internal API.
