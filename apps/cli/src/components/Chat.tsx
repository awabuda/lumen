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
 *
 * We keep the component small on purpose — all the heavy lifting
 * happens in {@link Agent}. The component is just a bridge.
 */

import { Box, Text, useApp, useInput } from 'ink'
import Spinner from 'ink-spinner'
import TextInput from 'ink-text-input'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantMessage, Message, ToolCall, ToolResult } from '@lumen/core'
import type { BuiltAgent } from '../composition.js'

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

  const submit = useCallback(
    async (prompt: string) => {
      if (status === 'thinking' || prompt.trim().length === 0) return

      turnCounter.current += 1
      const myKey = turnCounter.current
      const turn: Turn = { key: myKey, user: prompt }
      setTurns((prev) => [...prev, turn])
      setStatus('thinking')
      setStreamingText('')
      setActiveTool(undefined)
      setInput('')

      const ctrl = new AbortController()
      abortRef.current = ctrl

      try {
        // Run synchronously: we don't have mid-run streaming wired in
        // yet (see Agent.stream()). When the run finishes, the final
        // AssistantMessage is the whole response. This is the
        // architectural seam where true streaming will plug in.
        const result = await built.agent.run({
          userMessage: prompt,
          signal: ctrl.signal,
        })
        setActiveSessionId(result.sessionId)
        setTurns((prev) =>
          prev.map((t) => (t.key === myKey ? { ...t, assistant: result.finalMessage } : t)),
        )
        setStatus('done')
        setStreamingText(result.finalMessage.content ?? '')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof Error && err.name === 'AbortError') {
          setStatus('idle')
        } else {
          setTurns((prev) => prev.map((t) => (t.key === myKey ? { ...t, error: message } : t)))
          setStatus('error')
        }
      } finally {
        abortRef.current = null
      }
    },
    [built.agent, status],
  )

  // Ctrl+C handling: abort the in-flight run, or exit if idle.
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (abortRef.current) {
        abortRef.current.abort()
      } else {
        exit()
      }
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
        <Text dimColor> · {built.model} · {built.tools.size} tools · session </Text>
        <Text dimColor>{activeSessionId.slice(0, 8) || '(new)'}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {turns.length === 0 ? (
          <Text dimColor>
            Ask me anything. Try: "list the files in the current directory" or "read package.json".
          </Text>
        ) : (
          turns.map((turn) => (
            <TurnView
              key={turn.key}
              turn={turn}
              streamingText={streamingText}
              isActive={status === 'thinking' && turn.error === undefined && turn.assistant === undefined}
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
        <Text>{': '}{turn.user}</Text>
      </Box>
      {turn.error !== undefined ? (
        <Box>
          <Text color="red" bold>
            lumen
          </Text>
          <Text color="red">{': '}{turn.error}</Text>
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
          {streamingText.length > 0 ? <Text>{' '}{streamingText}</Text> : null}
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
              {turn.assistant.content ? (
                <Text>{turn.assistant.content}</Text>
              ) : null}
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
      <Text dimColor>{' '}{argPreview}</Text>
      {result ? (
        <Text color={result.isError ? 'red' : 'green'}>
          {' '}→ {result.isError ? 'error' : 'ok'}
        </Text>
      ) : null}
    </Box>
  )
}
