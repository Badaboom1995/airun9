import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Per-worker Claude Code settings, injected at spawn via --settings so the
 * user's own config is never touched. The hooks are how workers report
 * lifecycle back to the app (ADR-0007 enhancement #2, Orca's hook pattern):
 * Stop fires when the agent finishes a turn (→ status "done", transcript
 * path captured), UserPromptSubmit when a new prompt starts a turn
 * (→ back to "running", including when the user types in the tab).
 */

const SETTINGS_DIR = join(homedir(), '.airun9', 'claude')

function hookCommand(binDir: string, event: string): object {
  // absolute path: hooks run in a plain sh, not the bootstrapped zsh
  return { hooks: [{ type: 'command', command: `"${join(binDir, 'airun9')}" hook ${event}` }] }
}

export interface ClaudeSettingsPaths {
  worker: string
  scout: string
}

export function ensureClaudeSettings(binDir: string): ClaudeSettingsPaths {
  mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 })

  const hooks = {
    Stop: [hookCommand(binDir, 'stop')],
    UserPromptSubmit: [hookCommand(binDir, 'prompt-submit')]
  }

  const worker = join(SETTINGS_DIR, 'worker-settings.json')
  writeFileSync(worker, JSON.stringify({ hooks }, null, 2))

  // scouts are read-only: plan mode does the steering, deny rules are the backstop
  const scout = join(SETTINGS_DIR, 'scout-settings.json')
  writeFileSync(
    scout,
    JSON.stringify({ hooks, permissions: { deny: ['Edit', 'Write', 'NotebookEdit'] } }, null, 2)
  )

  return { worker, scout }
}
