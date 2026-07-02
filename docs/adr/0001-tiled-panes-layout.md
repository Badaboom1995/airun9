# ADR-0001: Tiled panes as the primary layout, serialized as data

Date: 2026-07-02 · Status: accepted

## Context

AIRUN9's workspace must host many blocks (terminals, editors, agent views,
schemas). Candidates: free-form infinite canvas (Figma-like), tiled panes
(VS Code/dockview-like), or a hybrid. Reference apps: Superset built a
headless panes engine; Orca uses serialized tab-groups with splits.

## Decision

The primary layout is **tiled panes**: splits + tabs, every block instance is
a pane. Layout state is **pure serialized data** in our own schema — never
locked into a specific rendering library — so agents and users can edit
layouts programmatically and the renderer can be swapped (start with dockview
or similar; a headless engine later if needed).

A free-form canvas may be added later as a special *view type* rendered
inside a pane (e.g. for schema maps), not as the primary metaphor.

## Consequences

- Dense, keyboard-friendly, deterministic — right default for daily IDE work
- "Layout = data" is a hard requirement on day one (see ADR-0003)
- Floating/overlay widgets are supported as a flag on a block instance
  (rendered in an overlay portal), not a separate layout system
