# AIRUN9 Glossary

Ubiquitous language for the project. If code or docs use a different word for
one of these concepts, fix the code/docs.

- **Project** — a repository the user has opened in AIRUN9. Multiple projects
  can be open simultaneously. The user owns the git credentials and API keys
  associated with their work (BYO keys).
- **Worker** — one isolated agent executing a task. Owns: a git worktree (its
  isolation mechanism — implementation detail, not user-facing vocabulary),
  an agent session, and its terminals. Workers are location-transparent
  (ADR-0005): local today, possibly remote later.
- **Layout** — the arrangement of panes/blocks in the app window (tiled
  panes, ADR-0001). v1 has exactly one global Layout spanning all open
  Projects; blocks reference resources by ID, so it freely mixes Projects
  and Workers. Serialized as pure data; editable by users and agents alike.
  Saved presets / per-project layouts are future options.
- **Block** — the unit of UI. A typed component with a zod-validated config,
  instantiated in views (or floated as an overlay widget). Blocks reference
  resources, never own them. Built-in blocks: terminal, editor, file tree,
  diff, agent status, browser, schema views, generic button/list (bound to
  declarative actions).
- **Declarative action** — a data-described side effect bound to a block
  (e.g. `{rpc: "git.commitAndPush", args: {…}}`), validated and executed by
  the app through the internal API. The v1 answer to "custom UI logic
  without user code" (ADR-0003).
- **Internal API** — the single capability-scoped surface (ADR-0004) through
  which all blocks, views, actions, agents, and (later) CLI/mobile/cloud
  clients act on the app. One API, many consumers.
- **Capability** — a named permission domain on the internal API
  (`git.write`, `terminal.exec`, …). Content declares required capabilities;
  provenance decides defaults (ADR-0003/0004).
- **Provenance tiers** — trust levels for UI content: built-in → local user
  (sovereign, opt-in dev mode) → imported → agent-generated (always treated
  as imported).
- **Developer mode** — explicit local opt-in that runs the user's own
  unsandboxed JSX blocks. Never a default, never a sharing format.
- **Public local API** — the internal API served on a local Unix socket,
  reachable from managed terminals via the bundled `airun9` CLI and via an
  MCP server (ADR-0008). Same capabilities, same audit log — agents and
  scripts are just more API consumers.
- **PTY daemon** — detached process owning all terminal PTYs (tmux model);
  the app attaches/detaches. Terminals survive app restarts. Its
  attach/detach protocol is designed to be network-capable (ADR-0005).
