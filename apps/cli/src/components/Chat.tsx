/**
 * Chat — the Ink/React TUI component.
 *
 * State machine:
 *
 *   idle ──submit──▶ thinking ──stream-done──▶ done
 *     ▲                  │                       │
 *     │                  ▼                       │
 *     └────────────── error ◀── error ◀──────────┘
 *
 * Responsibilities:
 *   - Render message history (user + assistant)
 *   - Render streaming content with a Spinner while in flight
 *   - Render tool call chips (the agent loop calls tools; we show
 *     which one is running)
 *   - Capture user input and submit to the agent
 *   - Handle Ctrl+C to abort a run (AbortController)
 *   - History: Up/Down arrows cycle through previously-submitted
 *     commands. New (un-submitted) edits do NOT pollute history
 *     until Enter is pressed.
 *   - Slash commands: /clear empties the visible turn log,
 *     /exit and /quit call the Ink `useApp().exit()` to leave
 *     the TUI cleanly.
 */

import type {
  AgentCheckpoint,
  AssistantMessage,
  BaseCheckpointStore,
  ToolCall,
  ToolResult,
} from '@lumen/core'
import { Box, Text, useApp, useInput } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BuiltAgent } from '../composition.js'
import { classifyChatError } from './chat-error.js'
import { analyzeCurrentProject } from './project-analyzer.js'
import { messagesToTurns } from './restore-turns.js'
import { handleSessionsSlash } from './sessions-slash.js'
import {
  budgetSnapshotAsAssistant,
  handleLoopSlash,
  handlePlanSlash,
  handleTrustSlash,
  handleUnloopSlash,
  initProjectAsAssistant,
  reloadPersistedLoops,
} from './slash-commands.js'

/** A single turn (user + assistant) in the conversation log. */
interface Turn {
  readonly key: number
  readonly user: string
  readonly assistant?: AssistantMessage
  readonly error?: string
}

type Status = 'idle' | 'thinking' | 'done' | 'error'

interface ChatProps {
  /** The fully-built agent (provider, tools, hooks, memory). */
  readonly built: BuiltAgent
  /** Persistent checkpoint store shared across TUI turns. */
  readonly checkpointStore?: BaseCheckpointStore
  /** P32.4 — persistent cron/loop store, mounted on chat.tsx bridge. */
  readonly loopsStore?: import('@lumen/memory').SqliteLoopsStore
  /** Fresh in-progress snapshot discovered before mounting. Consumed once. */
  readonly initialResumeFrom?: AgentCheckpoint
  /** Step checkpoint cadence for each turn. */
  readonly checkpointInterval?: number
  /**
   * P32.1 — when persistence is on, the chat command derives a
   * stable session id (cwd-hash) and forwards it here. We pass
   * it to `streamRun({ sessionId })` so `Agent.executeLoop`
   * hits the `options.sessionId ?? checkpoint?.sessionId ?? newSessionId()`
   * fallback at the first branch and reuses our id instead of
   * generating a fresh uuid. The TUI also surfaces the id in
   * the bottom bar so the user knows which conversation they are in.
   */
  readonly sessionId?: string
}

export function Chat({
  built,
  checkpointStore,
  loopsStore,
  initialResumeFrom,
  checkpointInterval,
  sessionId,
}: ChatProps): JSX.Element {
  const { exit } = useApp()
  const [turns, setTurns] = useState<readonly Turn[]>([])
  const [input, setInput] = useState<string>('')
  const [status, setStatus] = useState<Status>('idle')
  const [streamingText, setStreamingText] = useState<string>('')
  const [activeTool, setActiveTool] = useState<ToolCall | undefined>(undefined)
  const [activeSessionId, setActiveSessionId] = useState<string>('')
  const turnCounter = useRef<number>(0)
  const resumeRef = useRef<AgentCheckpoint | undefined>(initialResumeFrom)

  // P32.2 — render the prior-conversation history into the
  // `turns` state on mount. The `chat.tsx` bridge already had
  // `findResumeCheckpoint` plumbing the latest in-progress
  // snapshot through `initialResumeFrom`, but Chat.tsx never
  // consumed it: pre-P32.2 the TUI always showed an empty chat
  // log on restart, regardless of whether the SqliteCheckpoint
  // Store had rows from previous turns. With this effect, the
  // user reopens `lumen chat` and immediately sees their prior
  // conversation rendered above the input box.
  //
  // The dependency array intentionally uses `initialResumeFrom`
  // rather than the messages themselves so the effect only runs
  // once on mount and on a *change* of the resumeFrom prop (e.g.
  // after `/sessions switch` lands in P32.3 it will trigger a
  // re-render with a different snapshot). The `messagesToTurns`
  // helper handles all the pairing rules; this effect stays
  // one-liner thin on purpose.
  useEffect(() => {
    if (initialResumeFrom === undefined) return
    const restored = messagesToTurns(initialResumeFrom.messages)
    if (restored.length === 0) return
    setTurns(restored)
    // `turnCounter` is the incrementing key source for live
    // streaming turns; seed it past the highest restored key so
    // a follow-up user message gets a key that does not collide
    // with any prior turn.
    turnCounter.current = restored.length
  }, [initialResumeFrom])

  // P32.4 — on chat mount, re-arm every loop previously
  // registered via `/loop` so closing and re-opening the TUI
  // does not silently kill the schedule. When the store is
  // empty the effect is a no-op; when it has rows we surface
  // a one-line "restored N loops from disk" message in the
  // chat log so the user sees the schedule is alive.
  useEffect(() => {
    if (loopsStore === undefined) return
    let cancelled = false
    const fire = async (id: string, prompt: string): Promise<void> => {
      try {
        // Drain the streaming generator without rendering the
        // result into the TUI — the loop runs in the background,
        // so the user's own input box stays responsive.
        for await (const _ev of built.agent.streamRun({ userMessage: prompt })) {
          // intentionally empty — we only want the side effect
          // of running the agent; the runtime handles persistence
          // and tool dispatch as usual.
        }
      } catch (err) {
        process.stderr.write(
          `[loop] ${id} fire error: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    }
    void reloadPersistedLoops(loopsStore, fire).then((restored) => {
      if (cancelled || restored.length === 0) return
      const message = `[loop] restored ${restored.length} loop${restored.length === 1 ? '' : 's'} from disk:\n${restored.map((l) => `  ${l.id}  ${l.kind}${l.intervalMs !== undefined ? ` every ${Math.round(l.intervalMs / 1000)}s` : l.cronExpr !== undefined ? ` cron="${l.cronExpr}"` : ''}`).join('\n')}`
      setTurns((prev) => [
        ...prev,
        {
          key: prev.length + 1,
          user: '',
          assistant: {
            role: 'assistant',
            content: message,
            toolCalls: [],
          },
        },
      ])
      turnCounter.current += 1
    })
    return () => {
      cancelled = true
    }
  }, [loopsStore, built.agent])

  // Per-run AbortController so Ctrl+C can cancel an in-flight run.
  const abortRef = useRef<AbortController | null>(null)

  // History buffer (most-recent first). The text currently in
  // the input box is *not* part of history until Enter is
  // pressed; Up/Down arrows navigate this array. The first
  // entry is a sentinel `''` representing the "new line" the
  // user is composing when they press Up to start recalling.
  const [history, setHistory] = useState<readonly string[]>([])
  const [historyCursor, setHistoryCursor] = useState<number>(-1)
  // When the user starts navigating history, snapshot what
  // they had typed so Down-arrow can restore it.
  const draftRef = useRef<string>('')

  // P30.A2 — when the operator typed `/init`, the `submit`
  // function rewrites `trimmed` to a multi-line synthesis
  // prompt before it reaches the regular streamRun path.
  // The turn that gets rendered below should still display
  // `/init` as the user label, not the full prompt. This
  // ref carries the override from the rewrite site to the
  // turn-creation site. Cleared after each submit.
  const initLabelRef = useRef<string | null>(null)

  const submit = useCallback(
    async (prompt: string) => {
      let trimmed = prompt.trim()
      if (status === 'thinking' || trimmed.length === 0) return

      // Slash commands. We only handle the ones that affect UI
      // here; anything else is sent to the agent unchanged.
      if (trimmed === '/clear') {
        setTurns([])
        setInput('')
        setHistoryCursor(-1)
        draftRef.current = ''
        return
      }
      if (trimmed === '/exit' || trimmed === '/quit') {
        exit()
        return
      }
      // P23.12 (fix #71) — /cost runs the budget snapshot helper.
      // Reads built.agent.budgetSnapshot() (P23.12) which exposes
      // the most recent Budget instance from the agent loop.
      if (trimmed === '/cost' || trimmed.startsWith('/cost ')) {
        const snapshot = budgetSnapshotAsAssistant(built)
        const turn: Turn = { key: turnCounter.current + 1, user: trimmed }
        turnCounter.current += 1
        setTurns((prev) => [
          ...prev,
          turn,
          {
            key: turnCounter.current + 1,
            user: '',
            assistant: snapshot,
          } satisfies Turn,
        ])
        turnCounter.current += 1
        setStatus('done')
        setStreamingText('')
        setInput('')
        return
      }
      // P34.3 (Phase B.3) — `/trust` reads every
      // record from built.memory and emits a
      // per-kind count + mean/min/max trust summary.
      // Reads `built.memory` (the agent's SqliteStore)
      // directly; no LLM call.
      if (trimmed === '/trust' || trimmed.startsWith('/trust ')) {
        const result = await handleTrustSlash(built)
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: result.message,
          toolCalls: [],
        }
        const turn: Turn = { key: turnCounter.current + 1, user: trimmed }
        turnCounter.current += 1
        setTurns((prev) => [
          ...prev,
          turn,
          {
            key: turnCounter.current + 1,
            user: '',
            assistant: assistantMsg,
          } satisfies Turn,
        ])
        turnCounter.current += 1
        setStatus('done')
        setStreamingText('')
        setInput('')
        return
      }
      // P34.3 (Phase B.3) — `/plan` reads the live
      // `PlanStore` that PlanMiddleware writes into
      // and prints every saved plan with its step
      // count. When the assistant assembly is in use
      // (default), the store is wired by buildAgent
      // and the operator sees the plan the agent is
      // currently executing.
      if (trimmed === '/plan' || trimmed.startsWith('/plan ')) {
        const result = await handlePlanSlash(built)
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: result.message,
          toolCalls: [],
        }
        const turn: Turn = { key: turnCounter.current + 1, user: trimmed }
        turnCounter.current += 1
        setTurns((prev) => [
          ...prev,
          turn,
          {
            key: turnCounter.current + 1,
            user: '',
            assistant: assistantMsg,
          } satisfies Turn,
        ])
        turnCounter.current += 1
        setStatus('done')
        setStreamingText('')
        setInput('')
        return
      }
      // P32.3 — /sessions lists + manages stored checkpoint
      // sessions from chat.sqlite. Sub-cmd dispatch lives in
      // `sessions-slash.ts`; here we only forward the call with
      // the TUI's currentSessionId (populated from the run:start
      // event) so the active row gets a `←` marker.
      if (trimmed === '/sessions' || trimmed.startsWith('/sessions ')) {
        if (checkpointStore === undefined) {
          const assistantMsg: AssistantMessage = {
            role: 'assistant',
            content:
              '[sessions] no checkpoint store wired — run `lumen chat` (not `--no-persist`) to enable',
            toolCalls: [],
          }
          const turn: Turn = { key: turnCounter.current + 1, user: trimmed }
          turnCounter.current += 1
          setTurns((prev) => [
            ...prev,
            turn,
            {
              key: turnCounter.current + 1,
              user: '',
              assistant: assistantMsg,
            } satisfies Turn,
          ])
          turnCounter.current += 1
          setStatus('done')
          setStreamingText('')
          setInput('')
          return
        }
        const result = await handleSessionsSlash(trimmed, {
          checkpointStore,
          currentSessionId: activeSessionId,
        })
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: result.message,
          toolCalls: [],
        }
        const turn: Turn = { key: turnCounter.current + 1, user: trimmed }
        turnCounter.current += 1
        setTurns((prev) => [
          ...prev,
          turn,
          {
            key: turnCounter.current + 1,
            user: '',
            assistant: assistantMsg,
          } satisfies Turn,
        ])
        turnCounter.current += 1
        setStatus('done')
        setStreamingText('')
        setInput('')
        return
      }
      // P23.12 (fix #69) — /loop registers an IntervalCron or
      // CronExpressionCron (depending on argument shape).
      // Argument formats:
      //   /loop 5m <prompt>            → every 5 minutes
      //   /loop hourly <prompt>        → every hour
      //   /loop "*/5 * * * *" <prompt> → cron expression
      // P30.A1: every tick now actually fires the agent loop
      // (was stderr-only pre-P30.A1).
      // P32.4: the registration is also written to SqliteLoopsStore
      // (when one is wired) so closing the TUI does not lose
      // the schedule.
      if (trimmed.startsWith('/loop ') || trimmed === '/loop') {
        const result = await handleLoopSlash(trimmed, built, {
          ...(loopsStore !== undefined ? { store: loopsStore } : {}),
        })
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: result.message,
          toolCalls: [],
        }
        const turn: Turn = { key: turnCounter.current + 1, user: trimmed }
        turnCounter.current += 1
        setTurns((prev) => [
          ...prev,
          turn,
          {
            key: turnCounter.current + 1,
            user: '',
            assistant: assistantMsg,
          } satisfies Turn,
        ])
        turnCounter.current += 1
        setStatus('done')
        setStreamingText('')
        setInput('')
        return
      }
      // P32.4 — /unloop <id> stops a loop registered via /loop.
      // The persisted row is also marked inactive so a future
      // `lumen chat` launch will not re-arm it.
      if (trimmed.startsWith('/unloop')) {
        const result = await handleUnloopSlash(trimmed, {
          ...(loopsStore !== undefined ? { store: loopsStore } : {}),
        })
        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: result.message,
          toolCalls: [],
        }
        const turn: Turn = { key: turnCounter.current + 1, user: trimmed }
        turnCounter.current += 1
        setTurns((prev) => [
          ...prev,
          turn,
          {
            key: turnCounter.current + 1,
            user: '',
            assistant: assistantMsg,
          } satisfies Turn,
        ])
        turnCounter.current += 1
        setStatus('done')
        setStreamingText('')
        setInput('')
        return
      }
      // P30.A2 — /init now actually synthesizes a CLAUDE.md
      // via a real agent run. The factsheet from
      // `analyzeCurrentProject` is the input to a one-shot
      // mini-summarization pass; the model is asked to write
      // a CLAUDE.md that combines the factsheet with
      // project-specific guidance.
      //
      // The TUI displays the user-typed `/init` as the turn
      // label and the streaming model output as the assistant
      // message; we just inject a synthetic prompt and let
      // the regular streamRun path handle the rest.
      //
      // If the user typed `/init --factsheet-only` (or the
      // short form `/init factsheet`), we keep the pre-P30.A2
      // behaviour: a synthetic assistant turn with the
      // factsheet inline. Useful for operators who want to
      // see what the analyzer found without spending a model
      // call.
      if (trimmed === '/init' || trimmed.startsWith('/init ')) {
        const rest = trimmed.replace(/^\/init\s*/, '').trim()
        if (rest === 'factsheet' || rest === '--factsheet-only') {
          const placeholder = initProjectAsAssistant()
          const turn: Turn = { key: turnCounter.current + 1, user: trimmed }
          turnCounter.current += 1
          setTurns((prev) => [
            ...prev,
            turn,
            {
              key: turnCounter.current + 1,
              user: '',
              assistant: placeholder,
            } satisfies Turn,
          ])
          turnCounter.current += 1
          setStatus('done')
          setStreamingText('')
          setInput('')
          return
        }
        // Synthesize path: rewrite the user message and let
        // the regular streamRun path handle the rest. The
        // factsheet is appended inline; the model is told
        // to write to a CLAUDE.md file in the cwd.
        const { factsheet } = analyzeCurrentProject()
        const synthPrompt = [
          'You are a project initialization assistant. The operator typed `/init` in the lumen TUI.',
          '',
          'Synthesize a CLAUDE.md file from the factsheet below. The file should:',
          '  1. Summarize the project (1-2 paragraphs) — what it is, what language/framework, what package manager.',
          '  2. List the canonical commands (test, build, lint, typecheck) verbatim from the scripts section.',
          '  3. Note the top-level directory layout (src / test / docs / etc.).',
          '  4. End with a "## Operator notes" section the operator can fill in.',
          '',
          'Write the file to `./CLAUDE.md` (relative to the cwd) using the write_file tool. Do NOT print the full CLAUDE.md in the chat — the file on disk is the deliverable. After writing, reply with a one-line summary of what you wrote.',
          '',
          'FACTSHEET:',
          '',
          factsheet,
        ].join('\n')
        // Replace the user-typed input with the synthesis
        // prompt. We stash the original label in a closure
        // variable so the turn rendered below can show `/init`
        // instead of the multi-line prompt.
        initLabelRef.current = '/init'
        trimmed = synthPrompt
        // Don't `return` — fall through to the regular
        // streamRun path.
      }

      // Push to history (most-recent first, dedup consecutive).
      setHistory((prev) => {
        if (prev[0] === trimmed) return prev
        return [trimmed, ...prev].slice(0, 200)
      })
      setHistoryCursor(-1)
      draftRef.current = ''

      turnCounter.current += 1
      const myKey = turnCounter.current
      const turnLabel = initLabelRef.current ?? trimmed
      const turn: Turn = { key: myKey, user: turnLabel }
      initLabelRef.current = null
      setTurns((prev) => [...prev, turn])
      setStatus('thinking')
      setStreamingText('')
      setActiveTool(undefined)
      setInput('')

      const ctrl = new AbortController()
      abortRef.current = ctrl

      // Streaming: subscribe to the agent's run events and update UI
      // state in real time. Each event mutates React state; Ink will
      // re-render the affected subtree.
      try {
        const resumeFrom = resumeRef.current
        resumeRef.current = undefined
        for await (const ev of built.agent.streamRun({
          userMessage: trimmed,
          signal: ctrl.signal,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(checkpointStore ? { checkpointStore } : {}),
          ...(resumeFrom ? { resumeFrom } : {}),
          ...(checkpointInterval !== undefined ? { checkpointInterval } : {}),
        })) {
          switch (ev.type) {
            case 'run:start':
              setActiveSessionId(ev.sessionId)
              break
            case 'text:start':
              setStreamingText('')
              break
            case 'text:delta':
              setStreamingText((prev) => prev + ev.delta)
              break
            case 'text:end':
              // Text for this step is done; we'll commit to the turn
              // on step:end below.
              break
            case 'tool:start':
              setActiveTool(ev.toolCall)
              break
            case 'tool:end':
              setActiveTool(undefined)
              break
            case 'step:end':
              setTurns((prev) =>
                prev.map((t) => {
                  if (t.key !== myKey) return t
                  // Replace the assistant message on the latest step.
                  // Multi-step responses: the last step:end wins.
                  return { ...t, assistant: ev.message }
                }),
              )
              setStreamingText('')
              break
            case 'run:end':
              setStatus('done')
              break
            case 'error':
              // We won't actually reach this — streamRun re-throws
              // after yielding 'error'. The catch below handles it.
              break
          }
        }
        setStatus('done')
      } catch (err) {
        // Classifier lives in `chat-error.ts` so the TUI render
        // path stays one-liner thin and the rule is unit-testable.
        // Three routes:
        //   - `user-abort`: Ctrl+C, pre-aborted, or any other
        //     AbortError not carrying the `interrupt:` prefix.
        //     Silently reset to idle (pre-P20.1.2 behaviour).
        //   - `interrupt`: `createInterruptMiddleware` abort.
        //     Surface the message in the turn log so the user
        //     can see which tool tripped the rule and decide
        //     to retry with a different --interrupt-on list.
        //   - `error`: any non-AbortError. Surface the message
        //     in the turn log (also pre-P20.1.2 behaviour).
        const route = classifyChatError(err)
        if (route.kind === 'user-abort') {
          setStatus('idle')
          setStreamingText('')
          setActiveTool(undefined)
        } else {
          // `interrupt` and `error` share the same render path:
          // a red `lumen: <message>` line in the turn log + a
          // red border on the input box (driven by `status ===
          // 'error'` below).
          const message = route.message
          setTurns((prev) => prev.map((t) => (t.key === myKey ? { ...t, error: message } : t)))
          setStatus('error')
        }
      } finally {
        abortRef.current = null
        setActiveTool(undefined)
        setStreamingText('')
      }
    },
    [
      activeSessionId,
      built,
      built.agent,
      checkpointInterval,
      checkpointStore,
      exit,
      loopsStore,
      sessionId,
      status,
    ],
  )

  // Keyboard input:
  //   - Ctrl+C: abort the in-flight run, or exit if idle
  //   - Up arrow: recall the previous command (older)
  //   - Down arrow: recall the next command (newer)
  //
  // The arrow keys are intercepted BEFORE the TextInput
  // component sees them. We do this by listening on the Ink
  // app-level `useInput` hook, which fires for every key.
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (abortRef.current) {
        abortRef.current.abort()
      } else {
        exit()
      }
      return
    }
    // History navigation only when the user is composing
    // (status !== 'thinking' — we do not want arrow keys to
    // fire while the agent is in flight; the TextInput is
    // hidden then anyway).
    if (status === 'thinking') return
    if (key.upArrow) {
      // First Up press: snapshot whatever the user typed.
      if (historyCursor === -1) draftRef.current = input
      const next = Math.min(history.length - 1, historyCursor + 1)
      const recalled = history[next]
      if (recalled !== undefined) {
        setHistoryCursor(next)
        setInput(recalled)
      }
      return
    }
    if (key.downArrow) {
      if (historyCursor === -1) return
      const next = historyCursor - 1
      if (next < 0) {
        // Back to the user's draft
        setHistoryCursor(-1)
        setInput(draftRef.current)
      } else {
        const recalled = history[next]
        if (recalled !== undefined) {
          setHistoryCursor(next)
          setInput(recalled)
        }
      }
      return
    }
  })

  // When status flips to done, freeze the streaming text in the turn.
  useEffect(() => {
    if (status === 'done') {
      setStreamingText('')
      setActiveTool(undefined)
    }
  }, [status])

  const statusLabel = useMemo<string>(() => {
    if (status === 'thinking') return activeTool ? `running ${activeTool.name}...` : 'thinking...'
    if (status === 'done') return 'ready'
    if (status === 'error') return 'error'
    return 'idle'
  }, [status, activeTool])

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          lumen
        </Text>
        <Text dimColor>
          {' '}
          · {built.model} · {built.tools.size} tools · session{' '}
        </Text>
        <Text dimColor>{activeSessionId.slice(0, 8) || '(new)'}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {turns.length === 0 ? (
          <Text dimColor>
            Ask me anything. Slash commands: /clear, /exit, /quit. Up/Down for history.
          </Text>
        ) : (
          turns.map((turn) => (
            <TurnView
              key={turn.key}
              turn={turn}
              streamingText={streamingText}
              isActive={
                status === 'thinking' && turn.error === undefined && turn.assistant === undefined
              }
            />
          ))
        )}
      </Box>

      <Box borderStyle="round" borderColor={status === 'error' ? 'red' : 'cyan'} paddingX={1}>
        {status === 'thinking' ? (
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> {statusLabel}</Text>
          </Box>
        ) : (
          <Box>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(value: string) => {
                void submit(value)
              }}
              placeholder="Type a message and press Enter (Ctrl+C to cancel / exit)"
            />
          </Box>
        )}
      </Box>
    </Box>
  )
}

interface TurnViewProps {
  readonly turn: Turn
  readonly streamingText: string
  readonly isActive: boolean
}

function TurnView({ turn, streamingText, isActive }: TurnViewProps): JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="green" bold>
          you
        </Text>
        <Text>
          {': '}
          {turn.user}
        </Text>
      </Box>
      {turn.error !== undefined ? (
        <Box>
          <Text color="red" bold>
            lumen
          </Text>
          <Text color="red">
            {': '}
            {turn.error}
          </Text>
        </Box>
      ) : turn.assistant === undefined && isActive ? (
        <Box>
          <Text color="cyan" bold>
            lumen
          </Text>
          <Text>{': '}</Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          {streamingText.length > 0 ? <Text> {streamingText}</Text> : null}
        </Box>
      ) : turn.assistant !== undefined ? (
        <>
          <Box flexDirection="column">
            <Box>
              <Text color="cyan" bold>
                lumen
              </Text>
              <Text>{': '}</Text>
            </Box>
            <Box marginLeft={2} flexDirection="column">
              {turn.assistant.content ? <Text>{turn.assistant.content}</Text> : null}
              {turn.assistant.toolCalls.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                  {turn.assistant.toolCalls.map((tc: ToolCall) => (
                    <ToolCallChip key={tc.id} call={tc} result={undefined} />
                  ))}
                </Box>
              ) : null}
              {turn.assistant.finishReason === 'tool_calls' ? (
                <Text dimColor>(called tools, awaiting results...)</Text>
              ) : null}
            </Box>
          </Box>
        </>
      ) : null}
    </Box>
  )
}

interface ToolCallChipProps {
  readonly call: ToolCall
  readonly result: ToolResult | undefined
}

function ToolCallChip({ call, result }: ToolCallChipProps): JSX.Element {
  const argPreview = useMemo<string>(() => {
    try {
      const json = JSON.stringify(call.arguments)
      return json.length > 80 ? `${json.slice(0, 77)}...` : json
    } catch {
      return '(unserializable args)'
    }
  }, [call.arguments])

  return (
    <Box>
      <Text color="yellow">⚙ </Text>
      <Text color="yellow" bold>
        {call.name}
      </Text>
      <Text dimColor> {argPreview}</Text>
      {result ? (
        <Text color={result.isError ? 'red' : 'green'}> → {result.isError ? 'error' : 'ok'}</Text>
      ) : null}
    </Box>
  )
}
