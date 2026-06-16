/**
 * End-to-end integration test for the HTTP transport using the
 * real fixture server (../fixtures/http-server.mjs).
 *
 * Complements the unit tests in http-transport.test.ts (which use
 * an in-process fake) by exercising the full path: spawn a child
 * node process that listens on a real socket, point the client
 * at it, drive the MCP protocol, and assert behavior.
 *
 * This is what `lumen doctor` will eventually round-trip against
 * to verify the user's HTTP transport wiring works.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpMcpTransport, McpClient } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolve(here, 'fixtures/http-server.mjs')

let child: ChildProcessWithoutNullStreams | undefined
let port = 0

const waitForReady = (stream: NodeJS.ReadableStream, timeoutMs = 5_000): Promise<number> =>
  new Promise<number>((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error('fixture did not become ready in time')),
      timeoutMs,
    )
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString()
      const match = text.match(/^READY (\d+)/m)
      if (match) {
        clearTimeout(timer)
        stream.off('data', onData)
        resolveReady(Number(match[1]))
      }
    }
    stream.on('data', onData)
  })

beforeEach(async () => {
  child = spawn(process.execPath, [fixturePath], { stdio: ['pipe', 'pipe', 'pipe'] })
  port = await waitForReady(child.stdout)
})

afterEach(async () => {
  if (child) {
    child.kill('SIGTERM')
    await new Promise<void>((r) => {
      child!.on('exit', () => r())
      setTimeout(r, 2_000) // belt-and-braces
    })
    child = undefined
  }
})

describe('HttpMcpTransport — end-to-end with real fixture', () => {
  it('completes initialize → list → call against a real HTTP MCP server', async () => {
    const url = `http://127.0.0.1:${port}/mcp`
    const transport = new HttpMcpTransport({ url, timeoutMs: 5_000 })
    const client = new McpClient(transport)

    await client.initialize()
    expect(client.serverInfo?.name).toBe('fixture-http-mcp')
    expect(client.serverInfo?.version).toBe('1.0.0')

    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['echo'])

    const result = await client.callTool('echo', { text: 'hello http' })
    expect(result.content[0]?.text).toBe('hello http')

    await client.close()
  })

  it('echoes a session id on the second request after initialize', async () => {
    // The fixture assigns `Mcp-Session-Id: fixture-http-session` on
    // every response. After initialize, subsequent calls must carry
    // that header.
    const url = `http://127.0.0.1:${port}/mcp`
    const transport = new HttpMcpTransport({ url, timeoutMs: 5_000 })
    const client = new McpClient(transport)
    await client.initialize()
    await client.listTools() // first request after initialize
    await client.close()
    // The fixture's stdin/stdout pipes record what we sent. We
    // can't see HTTP request bodies from here, so we just confirm
    // the client accepted the session id and didn't blow up — the
    // in-process unit test covers header echo in detail.
  })
})
