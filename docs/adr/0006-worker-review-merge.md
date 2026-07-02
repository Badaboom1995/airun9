# ADR-0006: Worker completion — in-app review & merge, agent-assisted

Date: 2026-07-02 · Status: accepted

## Context

When a Worker finishes a task, its changes live on its worktree branch. The
review-and-integrate loop is core product value and should not require
leaving the app.

## Decision

- The user reviews the Worker's changes **in-app** (diff block over the
  Worker's branch vs its base).
- One primary action integrates the result into the Project (squash-merge to
  the base branch) and one discards it; the worktree is cleaned up
  afterwards.
- **Agent-assisted merging is a first-class goal**: an agent can be invoked
  to perform the integration work (resolve conflicts, rebase, tidy commits)
  through the same internal API, with the user approving the final result.
  The "nice interface where the agent can do the work" is a block/action
  composition, not a special mode.
- PR-based flows (push branch, open PR on a forge) come later for teams.

## Consequences

- Requires: combined diff block, merge/discard actions on the internal API
  (`git.write` capability, destructive-op confirmation per ADR-0004)
- Merge conflicts become an agent task type, not a modal dead-end
- Blocks referencing a completed/discarded Worker need a tombstone state
  (open question in ADR-0002)
