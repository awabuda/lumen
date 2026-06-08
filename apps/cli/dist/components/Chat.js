import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
export function Chat({ built }) {
    const { exit } = useApp();
    const [turns, setTurns] = useState([]);
    const [input, setInput] = useState('');
    const [status, setStatus] = useState('idle');
    const [streamingText, setStreamingText] = useState('');
    const [activeTool, setActiveTool] = useState(undefined);
    const [activeSessionId, setActiveSessionId] = useState('');
    const turnCounter = useRef(0);
    // Per-run AbortController so Ctrl+C can cancel an in-flight run.
    const abortRef = useRef(null);
    const submit = useCallback(async (prompt) => {
        if (status === 'thinking' || prompt.trim().length === 0)
            return;
        turnCounter.current += 1;
        const myKey = turnCounter.current;
        const turn = { key: myKey, user: prompt };
        setTurns((prev) => [...prev, turn]);
        setStatus('thinking');
        setStreamingText('');
        setActiveTool(undefined);
        setInput('');
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
            // Run synchronously: we don't have mid-run streaming wired in
            // yet (see Agent.stream()). When the run finishes, the final
            // AssistantMessage is the whole response. This is the
            // architectural seam where true streaming will plug in.
            const result = await built.agent.run({
                userMessage: prompt,
                signal: ctrl.signal,
            });
            setActiveSessionId(result.sessionId);
            setTurns((prev) => prev.map((t) => (t.key === myKey ? { ...t, assistant: result.finalMessage } : t)));
            setStatus('done');
            setStreamingText(result.finalMessage.content ?? '');
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err instanceof Error && err.name === 'AbortError') {
                setStatus('idle');
            }
            else {
                setTurns((prev) => prev.map((t) => (t.key === myKey ? { ...t, error: message } : t)));
                setStatus('error');
            }
        }
        finally {
            abortRef.current = null;
        }
    }, [built.agent, status]);
    // Ctrl+C handling: abort the in-flight run, or exit if idle.
    useInput((inputChar, key) => {
        if (key.ctrl && inputChar === 'c') {
            if (abortRef.current) {
                abortRef.current.abort();
            }
            else {
                exit();
            }
        }
    });
    // When status flips to done, freeze the streaming text in the turn.
    useEffect(() => {
        if (status === 'done') {
            setStreamingText('');
            setActiveTool(undefined);
        }
    }, [status]);
    const statusLabel = useMemo(() => {
        if (status === 'thinking')
            return activeTool ? `running ${activeTool.name}...` : 'thinking...';
        if (status === 'done')
            return 'ready';
        if (status === 'error')
            return 'error';
        return 'idle';
    }, [status, activeTool]);
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Box, { marginBottom: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "lumen" }), _jsxs(Text, { dimColor: true, children: [" \u00B7 ", built.model, " \u00B7 ", built.tools.size, " tools \u00B7 session "] }), _jsx(Text, { dimColor: true, children: activeSessionId.slice(0, 8) || '(new)' })] }), _jsx(Box, { flexDirection: "column", marginBottom: 1, children: turns.length === 0 ? (_jsx(Text, { dimColor: true, children: "Ask me anything. Try: \"list the files in the current directory\" or \"read package.json\"." })) : (turns.map((turn) => (_jsx(TurnView, { turn: turn, streamingText: streamingText, isActive: status === 'thinking' && turn.error === undefined && turn.assistant === undefined }, turn.key)))) }), _jsx(Box, { borderStyle: "round", borderColor: status === 'error' ? 'red' : 'cyan', paddingX: 1, children: status === 'thinking' ? (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" ", statusLabel] })] })) : (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: '> ' }), _jsx(TextInput, { value: input, onChange: setInput, onSubmit: (value) => {
                                void submit(value);
                            }, placeholder: "Type a message and press Enter (Ctrl+C to cancel / exit)" })] })) })] }));
}
function TurnView({ turn, streamingText, isActive }) {
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Box, { children: [_jsx(Text, { color: "green", bold: true, children: "you" }), _jsxs(Text, { children: [': ', turn.user] })] }), turn.error !== undefined ? (_jsxs(Box, { children: [_jsx(Text, { color: "red", bold: true, children: "lumen" }), _jsxs(Text, { color: "red", children: [': ', turn.error] })] })) : turn.assistant === undefined && isActive ? (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", bold: true, children: "lumen" }), _jsx(Text, { children: ': ' }), _jsx(Text, { color: "cyan", children: _jsx(Spinner, { type: "dots" }) }), streamingText.length > 0 ? _jsxs(Text, { children: [' ', streamingText] }) : null] })) : turn.assistant !== undefined ? (_jsx(_Fragment, { children: _jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: "cyan", bold: true, children: "lumen" }), _jsx(Text, { children: ': ' })] }), _jsxs(Box, { marginLeft: 2, flexDirection: "column", children: [turn.assistant.content ? (_jsx(Text, { children: turn.assistant.content })) : null, turn.assistant.toolCalls.length > 0 ? (_jsx(Box, { flexDirection: "column", marginTop: 1, children: turn.assistant.toolCalls.map((tc) => (_jsx(ToolCallChip, { call: tc, result: undefined }, tc.id))) })) : null, turn.assistant.finishReason === 'tool_calls' ? (_jsx(Text, { dimColor: true, children: "(called tools, awaiting results...)" })) : null] })] }) })) : null] }));
}
function ToolCallChip({ call, result }) {
    const argPreview = useMemo(() => {
        try {
            const json = JSON.stringify(call.arguments);
            return json.length > 80 ? `${json.slice(0, 77)}...` : json;
        }
        catch {
            return '(unserializable args)';
        }
    }, [call.arguments]);
    return (_jsxs(Box, { children: [_jsx(Text, { color: "yellow", children: "\u2699 " }), _jsx(Text, { color: "yellow", bold: true, children: call.name }), _jsxs(Text, { dimColor: true, children: [' ', argPreview] }), result ? (_jsxs(Text, { color: result.isError ? 'red' : 'green', children: [' ', "\u2192 ", result.isError ? 'error' : 'ok'] })) : null] }));
}
//# sourceMappingURL=Chat.js.map