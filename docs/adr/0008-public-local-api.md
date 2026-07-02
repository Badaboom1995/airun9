# ADR-0008: Public local API — CLI + MCP over one socket; agents can spawn Workers

Date: 2026-07-02 · Status: accepted

## Context

Orchestration v1 (settling the question left open in round 2): the app ships
default blocks/UI to create Workers, AND any terminal agent must be able to
do the same — e.g. the user tells their Claude agent "run 3 workers on this
task, I'll pick the winner", the agent calls our API, three Workers start
with the default (configurable) agent.

## Decision

- The internal API is served over a **local Unix-domain-socket JSON-RPC
  server** in the main process — the same capability-scoped surface
  (ADR-0004) the UI uses. One dispatcher, many doors (Orca's unified-RPC
  lesson; also the future door for cloud/mobile per ADR-0005).
- Two doors ship for agents:
  1. A bundled **`airun9` CLI**, injected into the PATH of every managed
     terminal, with env vars for socket path + a **scoped auth token** per
     terminal, so every call is attributed (audit log).
  2. An **MCP server** exposing the same methods as tools
     (`worker_create`, `worker_list`, `worker_status`, `git_*`, …) —
     auto-registered for agents that speak MCP (Claude Code first).
- v1 orchestration = **app-native fan-out + agent-callable spawn**: "run
  this prompt on N Workers" exists as a UI action and as an API method; a
  status-board block tracks them; compare-and-merge closes the loop
  (ADR-0006). The full agent-to-agent message bus (Orca's coordinator,
  heartbeats, decision gates) is deferred until this foundation is proven.

Guardrails:

- `worker.spawn` capability with a **concurrency cap** (default ~4) and a
  confirmation the first time a given agent/terminal spawns Workers in a
  session (user-relaxable)
- Default Worker agent is a user setting; spawn requests may override it
- All spawns attributed to their caller in the audit log

## Addendum (same day): public agent pool

All Workers and managed terminals are **enumerable through the API**
(`worker.list`, `terminal.list`, scoped `terminal.read`) so any agent can
observe the pool — e.g. a summarizer agent answering "what's going on?".
A master agent **writing into** other agents' terminals (Orca's dispatch
pattern) is deliberately deferred; it rides on the `terminal.exec`
capability and needs its own safety design.

## Consequences

- "Agents orchestrating agents" arrives in v1 in its simplest safe form —
  no message bus required for the flagship "fan out 3, pick the winner" demo
- The CLI/MCP surface doubles as the app's automation/scripting story
- Socket + token design must anticipate remote daemons (ADR-0005)
