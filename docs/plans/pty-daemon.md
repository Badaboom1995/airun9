# PTY Daemon — implementation plan

> Status: phases 1–6 implemented (2026-07-22). Remaining: the "Later"
> section below.

Goal: terminals and agent sessions survive IDE quit/reload (ADR-0005's daemon
boundary). Modeled on Superset's `@superset/pty-daemon` (see
docs/research/superset.md), scoped to AIRUN9 v1.

The shape: a small detached background process owns every PTY. The Electron
app is just a client that attaches over a Unix socket. Closing the IDE
detaches; reopening reattaches. Agents keep running in between.

```
Electron main ──ndjson over ~/.airun9/ptyd.sock──▶ pty daemon ──▶ PTYs ──▶ claude/shells
   (client)                                        (owner, survives quit)
```

## Phase 1 — daemon process

New `src/daemon/` entry, built alongside main (electron-vite
`main.build.rollupOptions.input: { index, daemon }` → `out/main/daemon.js`).

- `src/daemon/terminals.ts`: today's `TerminalManager` moved nearly verbatim
  (same 512KB scrollback strings; `@xterm/headless` is a later upgrade).
  One change: the daemon computes no env itself — `terminal.create` params
  carry the full env additions (PATH, sockets, ZDOTDIR bootstrap), computed
  by the caller in main. Keeps the daemon dumb and restart-safe.
- `src/daemon/server.ts`: NDJSON request/response on
  `~/.airun9/ptyd.sock` (0700 dir, same pattern as `src/main/socket.ts`), plus
  pushed `{event, payload}` lines to clients that sent `subscribe`.
  Methods: `hello` (returns `DAEMON_VERSION` + pid), `subscribe`,
  `terminal.create/list/get/snapshot/read/write/resize/close/kill`,
  `shutdown` (with `killSessions` flag).
- Logs to `~/.airun9/pty-daemon.log`, simple size-based rotation (the daemon
  has no window; without this it's undebuggable).
- Spawn wrapper raises fd limit (Superset's EMFILE fix):
  `/bin/sh -c 'ulimit -n 1048576 ...; exec "$@"' sh <electron> daemon.js`.

## Phase 2 — supervisor + client in main

`src/main/ptyd-supervisor.ts`:

- `ensure()`: connect to socket (short timeout) → `hello` handshake → adopt.
  Nobody home → spawn `process.execPath out/main/daemon.js` with
  `ELECTRON_RUN_AS_NODE=1`, `detached: true`, `stdio` to the log file,
  `unref()` → wait for socket ready → connect. ELECTRON_RUN_AS_NODE keeps
  node-pty on the Electron ABI — no second native build (VS Code ptyHost
  trick).
- Version drift (`hello.version !== DAEMON_VERSION`): v1 policy is warn +
  offer "restart sessions to upgrade" — no fd handoff yet.
- Reconnect: socket drop → respawn/reconnect; sessions that vanished get
  synthesized `exit` events so workers reconcile.
- **Dev mode** (`is.dev`): attached child, fresh socket, torn down on quit —
  hot-reloads must not leak stale-code daemons (Superset's rule). Opt-in
  `AIRUN9_PTYD_PERSIST=1` flips dev to prod behavior for testing persistence
  itself.

`src/main/terminals.ts` becomes `TerminalClient`: same surface as today's
manager (EventEmitter `created/data/exit/closed` + methods), proxying the
socket. **All methods become async** — the one real refactor ripple. Call
sites to await-ify: `workers.ts` (spawn/read/write/kill/close),
`worktrees.ts`, `api.ts` terminal methods, `index.ts` (`adoptPanes`,
project-closed cleanup). Renderer API is already promise-shaped via RPC, so
it doesn't change.

## Phase 3 — persist worker metadata

The daemon keeps sessions alive, but *meaning* (terminal X = worker
"fix-login") lives in `WorkerManager`'s in-memory Map today.

- Persist the workers map to `~/.airun9/workers.json` on every mutation
  (write-then-rename, same as BlockStorage). JSON now; migrate to
  better-sqlite3/Drizzle when ADR-0010 storage lands broadly.
- Startup rehydrate + reconcile: row's terminal alive in daemon → restore
  worker with persisted status (hooks refresh it on next event); terminal
  gone (reboot, daemon died) → status `exited`.
- Stamp intent-to-kill (`disposeRequestedAt`) before killing, clear after —
  the reaper's retry signal for kills that never landed.

## Phase 4 — reattach UI

- `adoptPanes` already checks live terminal ids — with the daemon they
  actually ARE live after reload, so panes reattach instead of respawning;
  the respawn branch stays as reboot fallback. Snapshot replay to xterm
  already exists.
- Rehydrated workers reappear in the rail with their statuses.

## Phase 5 — quit policy

- Remove `terminals.disposeAll()` from `before-quit` (prod) — the point of
  the whole feature. Project-close still kills that project's sessions.
- Quit with running workers → dialog: "N agents are still working — Keep
  running in background / Stop them / Cancel".
- Tray icon: running-agents count, "Open AIRUN9", "Quit Completely"
  (daemon `shutdown {killSessions: true}`). Tray is the resource escape
  hatch; without it a keep-running daemon is uncontrollable once the IDE
  is closed.

## Phase 6 — reaper

In main, on startup + every 5 min: `daemon.list()` vs workers.json vs open
projects' layouts. Kill sessions nobody owns (worker closed, project gone,
pane gone), retry stamped-but-unconfirmed disposes. Prevents week-scale
orphan pileup.

## Later (explicitly out of v1)

- SIGSTOP/SIGCONT pause-on-quit option (differentiator Superset lacks)
- Daemon self-upgrade via fd handoff (needed once auto-update exists)
- Move the `airun9.sock` API + worker registry into the daemon (headless
  core; hooks keep working while IDE is closed; ADR-0005 remote boundary)
- `@xterm/headless` server-side scrollback
- Windows: named-pipe path + no ulimit/sh wrapper (design already portable)

## Known v1 gaps (accepted)

- IDE closed → `airun9.sock` is down → worker hook pings and `airun9` CLI
  calls fail until reopen; statuses catch up on next event after relaunch.
- App update while daemon holds old-version sessions → "restart sessions"
  prompt instead of seamless handoff.

## Order & rough size

1. Daemon extraction + protocol (largest, ~1 new file each side)
2. Supervisor + TerminalClient + async ripple
3. workers.json persistence + reconcile
4. adoptPanes reattach polish
5. Quit dialog + tray
6. Reaper

Each phase lands independently; 1–2 alone already give "reload without
losing terminals" in prod mode.
