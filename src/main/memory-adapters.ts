import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MemoryAgent, MemoryRole } from '../shared/types'

/**
 * One parser per agent CLI transcript format. Each takes the on-disk file the
 * CLI itself writes and reduces it to the normalized session shape the memory
 * DB stores. Parsers are pure (path in, messages out) so re-ingesting a file
 * is idempotent by construction.
 *
 * Formats (verified against real session files):
 * - claude: ~/.claude/projects/<slug>/<uuid>.jsonl — one JSON entry per line,
 *   {type: user|assistant, message: {role, content}, timestamp, cwd, sessionId}
 * - gpt (Codex): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl —
 *   {type: session_meta|response_item, payload}, messages/tool calls inside
 *   response_item payloads
 * - grok: ~/.grok/sessions/<urlencoded-cwd>/<session-id>/updates.jsonl —
 *   ACP session/update stream; message text arrives as consecutive
 *   *_message_chunk updates that must be coalesced into whole messages
 */

export interface ParsedMessage {
  role: MemoryRole
  content: string
  toolName: string | null
  ts: number | null
}

export interface ParsedSession {
  agent: MemoryAgent
  nativeId: string
  cwd: string | null
  startedAt: number | null
  messages: ParsedMessage[]
}

/** Chat text cap — memory keeps the substance, not 100k-char pastes */
const MAX_TEXT_CHARS = 8000
/** Tool calls/results are context, not content — keep them short */
const MAX_TOOL_CHARS = 2000

/** Injected wrappers that are harness plumbing, not what anyone said */
const NOISE_PREFIXES = [
  '<system-reminder>',
  '<local-command',
  '<command-name>',
  '<environment_context>',
  '<permissions instructions>',
  '<turn_context',
  '<user_instructions'
]

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function isNoise(text: string): boolean {
  return NOISE_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function parseLines(path: string): unknown[] {
  const entries: unknown[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // a torn tail line (file is being written) is expected; skip it
    }
  }
  return entries
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Join the text of content-part arrays like [{type: 'text', text}] */
function joinTextParts(content: unknown, textKeys: string[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const part = asRecord(item)
    if (!part) continue
    for (const key of textKeys) {
      const text = str(part[key])
      if (text && !isNoise(text)) {
        parts.push(text)
        break
      }
    }
  }
  return parts.join('\n')
}

// --- claude ---------------------------------------------------------------

export function parseClaudeTranscript(path: string): ParsedSession | null {
  const session: ParsedSession = {
    agent: 'claude',
    nativeId: basename(path, '.jsonl'),
    cwd: null,
    startedAt: null,
    messages: []
  }
  // tool_use blocks carry the name; their tool_result twin only carries the id
  const toolNames = new Map<string, string>()

  for (const raw of parseLines(path)) {
    const entry = asRecord(raw)
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue
    if (entry.isSidechain === true) continue // subagent traffic, not this conversation
    const message = asRecord(entry.message)
    if (!message) continue

    const ts = entry.timestamp ? Date.parse(String(entry.timestamp)) || null : null
    session.startedAt ??= ts
    session.cwd ??= str(entry.cwd)

    const content = message.content
    if (typeof content === 'string') {
      if (content && !isNoise(content)) {
        session.messages.push({
          role: 'user',
          content: clip(content, MAX_TEXT_CHARS),
          toolName: null,
          ts
        })
      }
      continue
    }
    if (!Array.isArray(content)) continue

    const texts: string[] = []
    for (const item of content) {
      const part = asRecord(item)
      if (!part) continue
      if (part.type === 'text') {
        const text = str(part.text)
        if (text && !isNoise(text)) texts.push(text)
      } else if (part.type === 'tool_use') {
        const name = str(part.name) ?? 'tool'
        if (str(part.id)) toolNames.set(part.id as string, name)
        session.messages.push({
          role: 'tool',
          content: clip(`call ${JSON.stringify(part.input ?? {})}`, MAX_TOOL_CHARS),
          toolName: name,
          ts
        })
      } else if (part.type === 'tool_result') {
        const text = joinTextParts(part.content, ['text'])
        if (text) {
          session.messages.push({
            role: 'tool',
            content: clip(`result ${text}`, MAX_TOOL_CHARS),
            toolName: toolNames.get(str(part.tool_use_id) ?? '') ?? null,
            ts
          })
        }
      }
    }
    if (texts.length > 0) {
      session.messages.push({
        role: entry.type === 'assistant' ? 'assistant' : 'user',
        content: clip(texts.join('\n'), MAX_TEXT_CHARS),
        toolName: null,
        ts
      })
    }
  }
  return session.messages.length > 0 ? session : null
}

// --- gpt (Codex) ------------------------------------------------------------

export function parseCodexRollout(path: string): ParsedSession | null {
  const session: ParsedSession = {
    agent: 'gpt',
    nativeId: basename(path, '.jsonl'),
    cwd: null,
    startedAt: null,
    messages: []
  }

  for (const raw of parseLines(path)) {
    const entry = asRecord(raw)
    if (!entry) continue
    const payload = asRecord(entry.payload)
    if (!payload) continue
    const ts = entry.timestamp ? Date.parse(String(entry.timestamp)) || null : null

    if (entry.type === 'session_meta') {
      session.nativeId = str(payload.id) ?? str(payload.session_id) ?? session.nativeId
      session.cwd = str(payload.cwd)
      session.startedAt = ts
      continue
    }
    if (entry.type !== 'response_item') continue

    if (payload.type === 'message') {
      // developer messages are injected harness instructions, not dialogue
      if (payload.role !== 'user' && payload.role !== 'assistant') continue
      const text = joinTextParts(payload.content, ['text', 'input_text', 'output_text'])
      if (text) {
        session.messages.push({
          role: payload.role,
          content: clip(text, MAX_TEXT_CHARS),
          toolName: null,
          ts
        })
      }
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const input = str(payload.arguments) ?? str(payload.input) ?? ''
      session.messages.push({
        role: 'tool',
        content: clip(`call ${input}`, MAX_TOOL_CHARS),
        toolName: str(payload.name) ?? 'tool',
        ts
      })
    } else if (
      payload.type === 'function_call_output' ||
      payload.type === 'custom_tool_call_output'
    ) {
      const text = str(payload.output) ?? joinTextParts(payload.output, ['text', 'input_text'])
      if (text) {
        session.messages.push({
          role: 'tool',
          content: clip(`result ${text}`, MAX_TOOL_CHARS),
          toolName: null,
          ts
        })
      }
    }
  }
  return session.messages.length > 0 ? session : null
}

// --- grok -------------------------------------------------------------------

export function parseGrokSession(path: string): ParsedSession | null {
  const sessionDir = dirname(path)
  const session: ParsedSession = {
    agent: 'grok',
    nativeId: basename(sessionDir),
    cwd: decodeCwdDir(basename(dirname(sessionDir))),
    startedAt: null,
    messages: []
  }
  const summary = asRecord(readJsonIfExists(join(sessionDir, 'summary.json')))
  const info = asRecord(summary?.info)
  if (info) session.cwd = str(info.cwd) ?? session.cwd

  // streaming chunks: consecutive updates of the same kind are one message
  let pending: { role: MemoryRole; texts: string[]; ts: number | null } | null = null
  const flush = (): void => {
    if (!pending) return
    const content = pending.texts.join('')
    if (content.trim()) {
      session.messages.push({
        role: pending.role,
        content: clip(content, MAX_TEXT_CHARS),
        toolName: null,
        ts: pending.ts
      })
    }
    pending = null
  }

  for (const raw of parseLines(path)) {
    const entry = asRecord(raw)
    const params = asRecord(entry?.params)
    const update = asRecord(params?.update)
    if (!entry || !update) continue
    const kind = str(update.sessionUpdate)
    if (!kind) continue
    const ts = typeof entry.timestamp === 'number' ? entry.timestamp * 1000 : null
    session.startedAt ??= ts

    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
      const role: MemoryRole = kind === 'user_message_chunk' ? 'user' : 'assistant'
      const text = str(asRecord(update.content)?.text) ?? ''
      if (pending && pending.role !== role) flush()
      pending ??= { role, texts: [], ts }
      pending.texts.push(text)
    } else if (kind === 'tool_call') {
      flush()
      session.messages.push({
        role: 'tool',
        content: clip(`call ${JSON.stringify(update.rawInput ?? {})}`, MAX_TOOL_CHARS),
        toolName: str(update.title) ?? 'tool',
        ts
      })
    } else if (kind !== 'agent_thought_chunk') {
      // thoughts are skipped but do not break a streaming message in two;
      // every other update kind is a message boundary
      flush()
    }
  }
  flush()
  return session.messages.length > 0 ? session : null
}

function decodeCwdDir(name: string): string | null {
  try {
    const decoded = decodeURIComponent(name)
    return decoded.startsWith('/') ? decoded : null
  } catch {
    return null
  }
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
