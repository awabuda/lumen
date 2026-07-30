/**
 * P32.2 — Translate a checkpoint's message history into Turn[] for
 * the Chat TUI to render before the user types a follow-up.
 *
 * The Agent stores every conversation as a flat `Message[]` on the
 * checkpoint payload (`messages_json` column in `SqliteCheckpointStore`).
 * The TUI's `turns` state is a `Turn[]` — pairs of (user utterance,
 * assistant reply) plus optional streaming/interrupt state — for
 * rendering one chat bubble per pair on the screen.
 *
 * This helper is the boundary between those two shapes. It is a
 * pure function so the React layer can stay one-line thin and so
 * the conversion logic is unit-testable without mounting Ink.
 *
 * Pairing rules (decided with the persistent-defaults philosophy
 * from P32.1: better to render *something* on every run than to
 * drop a recoverable message):
 *
 *   1. Drop `role: 'system'` messages — those are the prompt, not
 *      conversation. The TUI's status bar already shows the model
 *      and session id; the system prompt has no screen real estate
 *      here.
 *
 *   2. Drop `role: 'tool'` messages — the assistant's tool calls
 *      live on the immediately preceding assistant message's
 *      `toolCalls: ToolCall[]` field. Folding them into the prior
 *      turn keeps each turn coherent. We deliberately do NOT
 *      promote a tool result into a separate turn, because a
 *      tool call has no semantic value without the assistant's
 *      surrounding intent.
 *
 *   3. Sequence the remaining user/assistant messages pairwise:
 *      `[user, assistant(user), assistant(tool_calls),
 *       assistant(content)]` collapses to two turns:
 *      - turn A: user → assistant(user) (or tool_calls)
 *      - turn B: assistant(content)
 *      We append content to the LAST assistant in each run of
 *      assistants so multi-step tool loop runs surface as one
 *      turn per user utterance rather than N assistant bubbles.
 *
 *   4. An unpaired trailing user message (the case at
 *      `outcome: 'in_progress'` shutdown) renders as a turn with
 *      no `assistant` field set. The TUI's `TurnView` already
 *      handles `turn.assistant === undefined` by showing a
 *      spinner-style "lumen: …" placeholder; the user resumes by
 *      submitting and the existing `streamRun({ resumeFrom })`
 *      path continues generation as expected.
 *
 *   5. A leading user or assistant message with no preceding user
 *      (e.g. system + assistant from a model that opened the run
 *      with a greeting) becomes a turn with `user: ''` so the
 *      TUI still renders the assistant bubble. This keeps the
 *      check clean and prevents the bubble from disappearing.
 *
 * Why a dedicated module rather than inlining in Chat.tsx: the
 * messages→turns mapping is non-trivial (mid-stream assistants,
 * tool call folding, in-progress tail handling), belongs to
 * neither the storage layer nor the React layer, and benefits
 * from being testable in isolation. Putting it in `Chat.tsx`
 * would couple the helper to the React/Ink runtime.
 */

import type { AssistantMessage, Message, ToolCall } from '@lumen/core'

/**
 * A single chat bubble as the TUI renders it. Mirrors the shape
 * defined inline in `components/Chat.tsx` for the live-streaming
 * state — we keep a parallel definition here because the
 * alternative (exporting through `Chat.tsx`) would tie this pure
 * helper to React/Ink, defeating the purpose of the split.
 */
export interface RestoredTurn {
  readonly key: number
  readonly user: string
  readonly assistant?: AssistantMessage | undefined
}

/**
 * Coerce a `UserMessage.content` (string OR array of content parts)
 * into a single string for rendering. Image / attachment parts are
 * summarised as `[attachment]` so the TUI does not have to import
 * the multimodal content-part union. The original assistant
 * message is kept on the turn so a follow-up resume can still
 * inspect the full multimodal content if it needs to.
 */
const userContentToString = (content: UserMessage['content']): string => {
  if (typeof content === 'string') return content
  // ContentPart is a union (text | image | file | …). For the
  // message-history render path text dominates; non-text parts
  // collapse to a short marker.
  const parts: string[] = []
  for (const part of content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      (part as { type?: unknown }).type === 'text'
    ) {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    } else {
      parts.push('[attachment]')
    }
  }
  return parts.join('\n')
}

// Use UserMessage's content type via Message narrow so we don't
// re-import the schema at the boundary.
type UserMessage = Extract<Message, { role: 'user' }>
type AssistantMessageMaybe = Extract<Message, { role: 'assistant' }>

/**
 * Fold a run of assistant messages (a tool-call loop) into one
 * AssistantMessage whose `content` is the concatenation of all
 * text segments and whose `toolCalls` collects every tool call
 * the model requested across the loop iterations. The TUI's
 * `TurnView` already groups tool chips under a single bubble if
 * they are on the same AssistantMessage, so this fold preserves
 * the visual goal: one bubble per user utterance.
 */
const foldAssistants = (
  assistants: ReadonlyArray<AssistantMessageMaybe>,
): AssistantMessage | undefined => {
  if (assistants.length === 0) return undefined
  const textParts: string[] = []
  const toolCalls: ToolCall[] = []
  for (const a of assistants) {
    if (a.content !== undefined && a.content.length > 0) {
      textParts.push(a.content)
    }
    for (const tc of a.toolCalls) toolCalls.push(tc)
  }
  const folded: AssistantMessage = {
    role: 'assistant',
    toolCalls,
  }
  const content = textParts.join('\n')
  return content.length > 0 ? { ...folded, content } : folded
}

/**
 * Convert checkpoint messages back into a linear sequence of
 * `RestoredTurn`s suitable for `Chat.tsx` `setTurns(initial)`.
 */
export const messagesToTurns = (messages: readonly Message[]): readonly RestoredTurn[] => {
  const turns: RestoredTurn[] = []
  let currentUser: UserMessage | undefined
  let currentAssistants: AssistantMessageMaybe[] = []

  const flush = (): void => {
    const foldedAssistant = foldAssistants(currentAssistants)
    turns.push({
      // Keys start from 1 to match the inline Turn.counter in
      // Chat.tsx; the live-streaming path uses turnCounter.current
      // which also starts at 0 + 1 = 1.
      key: turns.length + 1,
      user: currentUser === undefined ? '' : userContentToString(currentUser.content),
      ...(foldedAssistant !== undefined ? { assistant: foldedAssistant } : {}),
    })
    currentUser = undefined
    currentAssistants = []
  }

  for (const m of messages) {
    if (m.role === 'system') {
      // rule 1
      continue
    }
    if (m.role === 'tool') {
      // rule 2
      continue
    }
    if (m.role === 'user') {
      // If we already have a pending assistant without a matched
      // user (rule 5), flush first so this user starts its own
      // turn.
      if (currentUser === undefined && currentAssistants.length > 0) {
        flush()
      }
      // If we already have a pending user without a following
      // assistant (rule 4 — in-progress tail), flush so we keep
      // the prior turn visible AND start a new one for this user.
      if (currentUser !== undefined) {
        flush()
      }
      currentUser = m
      continue
    }
    // m.role === 'assistant' — fold into the current run.
    if (currentUser === undefined) {
      // rule 5: render a leading assistant as a turn with `user: ''`
      currentUser = undefined
    }
    currentAssistants.push(m)
  }

  // Flush any trailing run. If the run has no user (rule 5) and
  // no assistants (shouldn't happen given the loop above) we
  // emit nothing.
  if (currentUser !== undefined || currentAssistants.length > 0) {
    flush()
  }

  return turns
}
