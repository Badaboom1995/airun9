# ADR-0010: Storage — better-sqlite3 + Drizzle

Date: 2026-07-02 · Status: accepted

## Context

Two candidates: `node:sqlite` (built into Electron's Node, zero native
addons, but no Drizzle support → hand-rolled migration helpers) vs
better-sqlite3 + Drizzle (typed schema, drizzle-kit migrations, mature —
but a native addon). Orca uses node:sqlite; Superset uses
better-sqlite3 + Drizzle.

## Decision

**better-sqlite3 + Drizzle.** Rationale:

- DX and speed of iteration: typed schema + generated migrations beat
  hand-written SQL/migration helpers, especially if the schema grows fast
- The native-addon cost is marginal here: node-pty already makes this a
  native-modules app, and the cost lands on build infrastructure, not users
- End users are never affected: electron-builder compiles matching binaries
  at package time (`postinstall: electron-builder install-app-deps`), and
  auto-updates ship complete bundles

Mitigations / eyes-open notes:

- CI builds per platform/arch so every artifact carries correct binaries
- Electron upgrades require a dev-machine rebuild (automatic on install;
  "NODE_MODULE_VERSION mismatch" = clear cache and reinstall)
- Contributors get prebuilt binaries for common Electron versions; only
  missing prebuilds require a local toolchain
- If native-addon friction ever outweighs Drizzle's DX, `node:sqlite` is a
  cheap fallback for our small schema — SQL is SQL

## Consequences

- Keep existing deps (better-sqlite3, drizzle-orm, drizzle-kit)
- Layout/settings may still live in JSON files; SQLite owns relational data
  (projects, workers, audit log)
