# ADR-0009: v1 scope

Date: 2026-07-02 · Status: accepted

## In

- **Default layout + JSON configuration** of blocks/layout (composition per
  ADR-0003; no sandbox, no custom code)
- **Strong terminals** — Superset-grade quality bar: no glitching, correct
  resizing, easy selection/copy. PTY daemon underneath (sessions survive
  restarts)
- **Terminal UX**: multiple terminal tabs; within a single tab, tmux-style
  splits
- **Workers** (worktree-backed) created via UI and via the internal API
  (ADR-0008: `airun9` CLI + MCP, fan-out with concurrency cap)
- **Public agent pool**: all Workers/terminals enumerable through the API so
  an agent can report on what's running
- **Diff review + merge UI** (ADR-0006) — human flow only; API shaped so an
  agent can do it later
- **File tree** and **editor** (CodeMirror) blocks
- **One Project** open at a time — but IDs/schema/API designed for multiple
  from day one (no single-project assumptions in the data model)

## Out (explicitly deferred)

- Custom-code blocks / sandbox (v2, ADR-0003)
- Agent-assisted merge execution (API-ready only)
- Browser block, schema views (app/pages/DB), canvas view type
- Master-agent writing into other agents' terminals (ADR-0008 addendum)
- Orchestration message bus / coordinator agent
- Cloud workers, SSH relay, mobile companion (ADR-0005)
- Multi-forge/PR flows, per-agent adapters (ADR-0007 enhancements)
- Click-to-position-cursor in terminals — postponed (may be provided by the
  TUI itself, e.g. Claude Code; if we build it: synthesized arrow-key
  sequences, the iTerm/Kitty option-click technique, best-effort per TUI)

## Notes

- The v1 demo scenario: tell your CLI agent "run 3 workers on this task",
  watch the status board, compare diffs, merge the winner (ADR-0008)
