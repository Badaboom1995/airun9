# ADR-0003: Custom UI — composition first, sandbox second, provenance-based trust

Date: 2026-07-02 · Status: accepted

## Context

The killer feature: every IDE capability is exposed through one internal API,
and users can build any interface over it. Full arbitrary JSX from day one
would put a security sandbox on the critical path before the product exists.
Rendering user JSX is easy; constraining what it can do is the real work. In
an agentic IDE, agent-generated UI is a prompt-injection vector (agents read
untrusted repos/webpages), and an API that includes terminal execution makes
unconstrained code RCE by design.

## Decision

Trust is based on **provenance**, in four tiers:

1. **Built-in blocks** — our code, full trust.
2. **Local user content** — the user is sovereign on their machine. An
   explicit opt-in **developer mode** may run the user's own unsandboxed
   JSX blocks locally. Never the default, never the sharing format.
3. **Imported content** (shared layouts/blocks, future marketplace) — untrusted:
   declarative-only, or (v2) sandboxed with explicit permission grants.
4. **Agent-generated UI** — always treated as tier 3. Agent output is
   untrusted input.

Rollout:

- **v1 — composition + declarative actions.** Layouts are JSON. Users/agents
  compose existing blocks and parameterize generic ones. `onClick` is a
  declarative action (`{rpc: "git.commitAndPush", args: {…}}`) validated and
  executed by the app. No user code executes. Floating widgets included.
- **v2 — sandboxed custom blocks.** Figma-plugin model: user JSX runs in a
  sandboxed iframe/worker with its own React, talking to the app only via a
  postMessage RPC bridge exposing the same internal API, gated by per-view
  capability grants (ADR-0004).

## Consequences

- The declarative-action API built for v1 is exactly the surface the v2
  sandbox speaks — no wasted work
- Sharing format is always declarative JSON and/or sandboxed bundles; raw
  local JSX is not shareable
- Every block config is zod-validated; user render errors are contained by
  error boundaries per pane
