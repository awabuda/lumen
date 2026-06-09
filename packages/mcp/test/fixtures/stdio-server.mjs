#!/usr/bin/env node
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

rl.on('line', (line) => {
  if (!line.trim()) return
  const req = JSON.parse(line)
  if (req.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (req.method === 'notifications/initialized') {
    write({ jsonrpc: '2.0', id: req.id, result: {} })
    return
  }
  if (req.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo text',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
      },
    })
    return
  }
  if (req.method === 'tools/call') {
    write({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: req.params?.arguments?.text ?? '' }] },
    })
    return
  }
  write({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
})
