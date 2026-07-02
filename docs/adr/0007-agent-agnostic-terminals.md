# ADR-0007: Agent-agnostic — any CLI agent runs in Worker terminals

Date: 2026-07-02 · Status: accepted

## Context

Orca ships ~35 per-vendor adapters (hooks, transcript parsers). Superset
injects shell wrappers. Alexey's position: "the app is all about terminals,
so you can run literally any agent that you have as CLI."

## Decision

- A Worker runs **any CLI agent** (Claude Code, Codex, Gemini, OpenCode,
  aider, …) — or any command at all — in its terminals. No per-agent
  integration is required for the core loop (isolate → run → review → merge,
  ADR-0006), which works on git state alone.
- Per-agent knowledge is a **progressive enhancement**, added case by case
  when it earns its keep, in this order of cheapness:
  1. Generic OSC/exit-code/silence heuristics for status (works for many
     CLIs at once)
  2. Per-agent status hooks (Orca's hook-service pattern)
  3. Transcript tailing for a native chat surface over a CLI agent
  4. Resume via the agent's own `--resume`
- The enhancement interface is defined once (an agent adapter contract), but
  v1 may ship with zero or one adapter implementations.

## Consequences

- The product is never blocked on vendor adapter work
- "See agents running" starts as "see Worker terminals + git activity +
  cheap status heuristics" and sharpens per-agent over time
- Users bring their own agent subscriptions/keys (consistent with ADR-0004)
