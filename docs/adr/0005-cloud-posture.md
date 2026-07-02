# ADR-0005: Cloud posture — local-first now, location-transparent Workers later

Date: 2026-07-02 · Status: accepted (direction)

## Context

Desired future: "cloud workers" — close the laptop and agents keep running;
possibly move entire coding sessions to the cloud. Today: no hosted infra,
no own API keys, open-source local app.

## Decision

v1 is **local-only**, but the **Worker abstraction must be
location-transparent from day one**: a Worker is addressed by ID through the
internal API, and nothing in the UI or API contract assumes its PTYs,
worktree, or filesystem are on this machine. The PTY-daemon architecture
(detached daemon, attach/detach protocol) is the same shape remote execution
needs, so the daemon boundary is the future network boundary.

When cloud lands, the order is: our own remote runner (SSH → relay binary,
per Orca's model) reusing the same daemon protocol; vendor-cloud attachments
(Codex/Devin/etc.) as adapters later if wanted. Cloud services are also where
paid tiers live (ADR-0004).

## Consequences

- No cloud code now; but no `localhost` assumptions in the API contract
- The daemon/attach protocol gets designed as if the daemon might be remote
- SSH terminals (system OpenSSH in PTY env) remain available to users
  regardless — that's just a thing terminals can run
