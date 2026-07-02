# Orca (stablyai/orca) — Architecture Research

> Reference study of https://github.com/stablyai/orca — "The AI Orchestrator
> for 100x builders." Studied 2026-07-02. Complements the Superset research:
> where Superset validates our stack, Orca shows what a pure
> orchestrator-of-CLI-agents looks like at scale.

## Thesis

Orca is not an "AI SDK app" — it's a **harness for ~35 external CLI coding
agents** (Claude Code, Codex, OpenCode, Gemini, Cursor, Devin, Grok, Amp, …),
each running inside a managed PTY terminal in its own git worktree. There is
no Vercel AI SDK, no Anthropic SDK, no tRPC, no Drizzle, no CodeMirror. All
LLM intelligence is outsourced to the CLIs; Orca's engineering goes into
orchestrating, observing, and unifying them.

## Stack (where it diverges from ours)

| Concern | Orca | AIRUN9 baseline |
| --- | --- | --- |
| Editor | Monaco + TipTap 3 for chat authoring | CodeMirror 6 |
| DB | `node:sqlite` (`DatabaseSync`, no native addon) | better-sqlite3 + Drizzle |
| Main↔renderer IPC | vanilla `ipcRenderer.invoke`, one audited preload file | trpc-electron |
| State | zustand single store, ~35 slices, no TanStack Query | zustand + TanStack Query |
| Lint/format | oxlint + oxfmt, tsgo typechecking | ESLint + Prettier |
| App state | JSON files; SQLite only for the orchestration bus | TBD |

Monorepo extras: `src/cli/` (bundled `orca` CLI), `src/relay/` (Electron-free
binary deployed to SSH hosts), `src/shared/` (~500 files shared logic),
`mobile/` (Expo/RN companion), `native/` (computer-use sidecars), `skills/`
(Claude-Code-format SKILL.md files shipped with the app).

## Mechanisms worth stealing

### 1. Unified triple-transport JSON-RPC runtime ⭐

One RPC method surface (`src/main/runtime/runtime-rpc.ts`,
`rpc/dispatcher.ts`, ~60 method modules) served simultaneously over:

- **Unix socket** — for the bundled CLI
- **WebSocket** (port 6768) with token auth + E2EE — for the mobile companion
- **SSH relay** — the same methods against remote hosts

CLI, phone, and remote all speak the same protocol. For AIRUN9: keep
trpc-electron for main↔renderer; design this second boundary (CLI/remote/
companion) as one dispatcher from the start.

### 2. Agents-orchestrating-agents message bus ⭐

`src/main/runtime/orchestration/{coordinator,db}.ts` +
`skills/orchestration/SKILL.md`:

- SQLite schema: `messages` (typed: status / dispatch / worker_done /
  merge_ready / escalation / handoff / decision_gate / heartbeat; priorities),
  `tasks` (DAG via `deps` JSON + `parent_id`), `dispatch_contexts`,
  `decision_gates`, `coordinator_runs`
- A polling `Coordinator` (2 s tick, `maxConcurrent` 4) dispatches ready tasks
  by **typing a generated preamble into the worker's terminal**
- Safety: circuit breaker (3 consecutive dispatch failures → task failed),
  stale-base drift guard (>20 commits behind base → skip), hung-worker
  detection (10 min without heartbeat → warn)
- The entire bus is exposed as a CLI (`orca orchestration send|check|ask|
  task-create|dispatch|gate-*|run`) so a **coordinator agent** can decompose
  work, dispatch to workers, and block on `check --wait`. Group addresses:
  `@idle`, `@claude`, `@worktree:<id>`

### 3. Native-chat-over-transcript ⭐

`src/main/native-chat/` renders a first-class chat pane on top of a
terminal-only agent by **tailing the agent's own JSONL transcript**
(`transcript-reader.ts`, `transcript-watch.ts`). Supports dozens of agents
with zero SDK integrations.

### 4. ai-vault session scanner

`src/main/ai-vault/` reads *other tools'* on-disk session stores (Claude
JSONL, Codex rollouts, OpenCode's SQLite, …) to reconstruct session metadata
and token usage. Resume delegates to each CLI's own `--resume` flag
(`src/shared/agent-session-resume.ts`). Don't duplicate state the agent
already persists.

### 5. PTY daemon, evolved

`src/main/daemon/` (~90 files) — same tmux model as Superset, further along:

- Detached daemon survives renderer reloads and app restarts;
  `terminal-host.ts` exposes `createOrAttach(sessionId) → {isNew, snapshot,
  attachToken}`
- Scrollback survives restart via `@xterm/headless` + serialize addon
  checkpoints
- Binary framing protocol, output scheduler (priority semaphore, data batcher,
  post-ready flush gate), OSC7 cwd tracking
- WebGL rendering with a patched addon; dedicated perf test suite
  (typing latency, redraw freeze, golden-image rendering)
- Provider abstraction: local PTY / SSH PTY / degraded-daemon fallback

### 6. Agent status via hooks + OSC parsing

Per-vendor `hook-service.ts` installs status hooks into each agent's own
config; combined with OSC escape-sequence parsing of the terminal stream
(`src/shared/agent-status-osc.ts`) to derive idle / working / awaiting-input /
done. Drives notifications and the "sleeping agent" restore system
(`SleepingAgentSessionRecord`: pane + worktree + provider session + last
message, with `origin: worktree-sleep | quit | live`).

### 7. Design Mode ⭐ (relevant to AIRUN9's UI-building agent)

Click any element in an embedded Chromium pane (`agent-browser` + CDP,
`src/main/browser/browser-grab-*`, `cdp-bridge.ts`) → its HTML, CSS, and a
cropped screenshot go into the agent's prompt. Plus browser-cookie import from
Chrome for authed testing.

### 8. E2EE mobile companion

Expo/RN app pairs via QR code; X25519 (tweetnacl) shared key, device registry,
`e2ee_hello`/`e2ee_auth` handshake (`src/main/runtime/rpc/e2ee-channel.ts`,
`mobile/src/transport/`). Streams terminals and browser screencast, sends
follow-up prompts, two-way audio for voice.

### 9. SSH beyond "borrow OpenSSH"

System OpenSSH first, bundled `ssh2` fallback, plus a **custom relay binary**
(`src/relay/`) deployed to the remote host serving fs/git/pty over one
multiplexed channel (`ssh-channel-multiplexer.ts`, versioned install). Remote
worktrees are first-class.

### 10. Git / diff review

- Shells out to `git` directly with rich porcelain parsing (~40 files in
  `src/main/git/`) — no simple-git
- Combined multi-file diff on Monaco with virtualized loading
- **Annotate AI Diffs**: inline comments as Monaco decorations
  (`src/renderer/src/components/diff-comments/`) that are fed back into the
  agent's prompt
- Multi-forge abstraction: GitHub / GitLab / Gitea / Bitbucket / Azure DevOps

## Skip / defer for AIRUN9

- The 35-agent adapter sprawl and per-vendor usage parsers — only if external
  CLI agents become our core loop
- Computer-use native sidecars (Swift/Python/PowerShell drive the real OS) and
  embedded iOS/Android emulator streaming — huge surface, niche payoff
- Homebrew Casks, i18n catalogs, fastlane — distribution polish
- Vanilla-IPC preload contract — trpc-electron is less boilerplate for
  main↔renderer; reserve JSON-RPC for the CLI/remote/mobile boundary

## Key files to study line-by-line (in a clone)

- `src/main/runtime/runtime-rpc.ts`, `src/main/runtime/rpc/dispatcher.ts`
- `src/main/runtime/orchestration/{coordinator,db,preamble}.ts`
- `src/main/daemon/{terminal-host,history-manager,daemon-spawner}.ts`
- `src/main/native-chat/transcript-reader.ts`
- `src/main/ai-vault/session-scanner.ts`
- `src/shared/agent-session-resume.ts`
- `src/main/runtime/rpc/e2ee-channel.ts` + `mobile/src/transport/pairing.ts`
- `src/main/browser/{browser-grab-payload,cdp-bridge}.ts`
- `src/preload/index.ts`, `src/renderer/src/store/{index,types}.ts`
