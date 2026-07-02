# ADR-0004: Local-first security — capability-scoped internal API

Date: 2026-07-02 · Status: accepted

## Context

AIRUN9 is open source; users bring their own git credentials and LLM API
keys. There is no server to enforce anything. Every client is untrusted by
default, but users may do whatever they want on their own machines. Our job
is tools + guardrails that make it hard to break things — not walls.

## Decision

Everything a block, view, action, or agent can do goes through the internal
API, which is **capability-scoped**. Initial capability domains:

| Capability | Examples | Default for imported/agent UI |
| --- | --- | --- |
| `fs.read` / `fs.write` | read/write files **scoped to opened Project dirs** | read: prompt · write: prompt |
| `git.read` | log, status, diff | allow |
| `git.write` | commit, push, branch, worktree ops | prompt |
| `terminal.read` | observe terminal output | prompt |
| `terminal.exec` | run commands / type into terminals | **explicit grant, always** |
| `worker.spawn` / `worker.control` | start/steer/stop agents | prompt |
| `layout.read` / `layout.write` | read/modify the layout | allow |
| `net.fetch` | outbound network from custom UI | **off by default** |
| `secrets.use` | use stored keys (never read them) | n/a — see below |
| `notify`, `clipboard` | notifications, clipboard | prompt |

Guardrails:

- **Secrets are write-only.** API keys live in the OS keychain; the API can
  *use* them on the user's behalf but never returns them to any block, view,
  or agent.
- **Path scoping.** `fs.*` is confined to opened Project directories (plus
  the worktrees dir); no arbitrary `$HOME` access.
- **Destructive-op confirmations.** Force-push, deletes, worktree removal
  prompt regardless of grants.
- **Audit log.** Every API call records its caller (which block/layout/agent),
  so "what just pushed to main?" is always answerable.
- Layouts/blocks **declare required capabilities**; importing a layout shows a
  grant screen (Figma-plugin style).

Free/paid restrictions are **not** enforced in the local app (open source
makes that meaningless); paid tiers can only gate hosted services (cloud
workers, sync, sharing infrastructure).

## Consequences

- The capability model is a security feature, not a licensing mechanism
- The same grants UI serves v2 sandboxed blocks (ADR-0003) unchanged
- Agents get *scoped* API tokens per Worker — a Worker can be restricted to
  its own worktree by construction
