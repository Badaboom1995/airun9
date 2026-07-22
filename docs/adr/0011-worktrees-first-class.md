# ADR-0011: Worktrees as first-class resources

Date: 2026-07-21 · Status: accepted · Amends ADR-0002, extends ADR-0004

## Context

ADR-0002 hid git worktrees inside Workers ("an implementation detail").
In practice a worktree is useful without a worker: the user opens terminals
in it and works manually, agents prepare several in parallel, finished work
awaits review in one. The worker-owned model also leaked: nothing ever
removed a worktree, and the app forgot them on restart.

## Decision

**Model**

- **Worktree** joins the domain vocabulary: an isolated checkout of a
  Project with its own branch. A Project has several; the **main checkout is
  the default worktree** — first in every list, never removable.
- A worktree needs no worker. Workers optionally run inside one; **several
  workers may share a worktree** (the user chooses this on the approval
  card — their risk).
- **Git is the source of truth.** No database rows: the worktree list is a
  fresh `git worktree list` (+ `prune`) every time. Externally created
  worktrees are adopted and managed like ours. Survives crashes for free.
  The only app-owned state is the per-project bootstrap command.

**Conventions**

- App-created worktrees: `~/.airun9/worktrees/<project>-<idhash>/<name>/`,
  branch `airun9/<name>`, name describes the task (agent or user picks it).
- Base = the project's current HEAD unless the caller passes a ref. The
  base is resolved to a fixed commit at request time and shown on the
  approval card ("main @ 40cc61a") — what the user approves is what runs.
- Creation copies root-level `.env*` from the main checkout (the one thing
  git cannot restore). Dependency install is NOT app magic: the agent (or
  user) runs it visibly in the worktree's terminal. The app remembers one
  bootstrap command per project as a prefill/suggestion.

**Gates (per ADR-0004: worktree ops are `git.write`)**

- Agent create → approval card (N worktrees = one card).
- UI create → the dialog itself is consent; no second card. Enforced by
  door-tagging in the API: consent methods (`worktree.create`,
  `*.resolveRequest`) refuse calls from the socket door.
- Remove → **always** an approval card, whoever asks, showing the blast
  radius computed at request time: dirty files, commits unmerged into the
  main checkout's HEAD, live workers/terminals inside. Approve = stop
  workers → close terminals → `git worktree remove --force` → optional
  branch delete (card checkbox). Branch kept = commits survive.

**Contexts: a worktree is a child workspace**

- Each worktree is a full content context with its own terminals, file
  root, and layout tree. Mechanism: activating a worktree opens it as a
  **child project** (`parentId` → the repo project, as ProjectManager
  always anticipated) — every project-scoped block switches at once, and
  pane adoption gives a fresh context its first terminal automatically.
- The **rail shows one chip per repo**; child contexts never become chips.
  The chip's chevron menu lists worktrees (main first, active marked);
  clicking a row switches context, clicking the chip returns to the main
  checkout. Vitals (running agents, pending approvals) aggregate across a
  repo's contexts, as does the approval modal.
- Closing a repo project closes its child contexts; removing a worktree
  closes its child context first (landing the user back on the repo).
- Terminals in a worktree context bind agents to the child project, so an
  agent spawned there works in that worktree by construction (ADR-0004's
  "restricted to its own worktree").
- Deferred end-state unchanged: a shared per-project layout *template*
  filled per context (the roles/template layout engine), if per-context
  layout divergence turns out to hurt.

## Consequences

- ADR-0002's "users should not need to understand worktrees" is superseded:
  the concept is now user-facing, but named work ("auth-refactor") rather
  than git jargon carries the meaning.
- ADR-0006's review/merge flow gains a natural home: a finished worktree
  persists after its worker exits until merged or discarded.
- Restart loses only nice-to-have metadata (who created a worktree, for
  what prompt) — acceptable; the task-derived name carries intent.
- `worker.resolveRequest` and the new consent methods are closed to the
  socket door — an agent can no longer approve its own request.
