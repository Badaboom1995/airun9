# ADR-0002: Domain model — Project, Worker, Layout, Block

Date: 2026-07-02 · Status: accepted (amended same day: "View" renamed to
"Layout", single global layout in v1)

## Context

We need a small, teachable vocabulary. Users should not need to understand
git worktrees to use agent isolation. Alexey's mental model: "the layout of
the app — panels, blocks — one for all projects for now."

## Decision

- **Project** — a repository the user has opened. Several projects can be
  open at once. The user owns their git config and API keys (BYO keys).
- **Worker** — one isolated agent doing a task. Under the hood a Worker owns
  a git worktree, an agent session, and its terminals. "Worktree" is an
  implementation detail; the user-facing concept is the Worker.
- **Layout** — the arrangement of panes/blocks in the app window (tiled
  panes, ADR-0001), serialized as pure data. **v1 has exactly one global
  Layout** spanning all open projects; blocks bind to resources by ID, so one
  layout freely mixes blocks from different Projects and Workers. Saved
  layout presets and per-project layouts are future options, kept possible by
  the data format.
- **Block** — the unit of UI. A typed component with a validated (zod)
  config, instantiated as panes in the Layout (or floated as overlay
  widgets). Blocks reference resources; they never own them.

## Resolved elsewhere

- Worker completion → ADR-0006 (in-app review & merge, agent-assisted)
- Agent roster → ADR-0007 (agent-agnostic terminals)

## Open questions

- Free-standing terminals (not owned by a Worker): default is
  **Project-scoped** (cwd = repo root) unless a reason emerges otherwise
- What a block displays when the Worker it references is gone (tombstone
  state) — needs design when Worker lifecycle is built
