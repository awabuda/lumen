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

import type { AssistantMessage, ToolCall, ToolResult } from '@lumen/core'
import { Box, Text, useApp, useInput } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BuiltAgent } from '../composition.js'
import { classifyChatError } from './chat-error.js'

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
}

export function Chat({ built }: ChatProps): JSX.Element {
  const { exit } = useApp()
  const [turns, setTurns] = useState<readonly Turn[]>([])
  const [input, setInput] = useState<string>('')
  const [status, setStatus] = useState<Status>('idle')
  const [streamingText, setStreamingText] = useState<string>('')
  const [activeTool, setActiveTool] = useState<ToolCall | undefined>(undefined)
  const [activeSessionId, setActiveSessionId] = useState<string>('')
  const turnCounter = useRef<number>(0)

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

  const submit = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim()
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

      // Push to history (most-recent first, dedup consecutive).
      setHistory((prev) => {
        if (prev[0] === trimmed) return prev
        return [trimmed, ...prev].slice(0, 200)
      })
      setHistoryCursor(-1)
      draftRef.current = ''

      turnCounter.current += 1
      const myKey = turnCounter.current
      const turn: Turn = { key: myKey, user: trimmed }
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
        for await (const ev of built.agent.streamRun({
          userMessage: trimmed,
          signal: ctrl.signal,
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
    [built.agent, exit, status],
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
