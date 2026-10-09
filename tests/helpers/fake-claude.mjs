#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI that speaks just enough of the Agent SDK's
 * stream-json protocol for a chat tab: it answers every control request, and each
 * user message gets one assistant reply, `echo: <text>`, and a successful result.
 * A message containing `[permission]` first asks to run Bash (`can_use_tool`) and
 * waits for the answer; the reply then ends in ` (allow)` or ` (deny)`.
 * Point `claudeCommand` at this file (the SDK runs `.mjs` paths with node).
 */
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID()
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
let initSent = false

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

function answerControl(request) {
  const response = request.request?.subtype === 'initialize'
    ? { commands: [], models: [], agents: [], account: {}, output_style: 'default', available_output_styles: ['default'] }
    : {}
  write({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response } })
}

function textOf(message) {
  const content = message.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
  return ''
}

/** Our own control requests to the SDK (permission asks), by request id. */
const asks = new Map()
let nextAsk = 0

function askPermission(command) {
  const requestId = `fake-ask-${++nextAsk}`
  write({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command }, tool_use_id: `toolu_fake_${nextAsk}` }
  })
  return new Promise((resolve) => asks.set(requestId, resolve))
}

function ensureInit() {
  if (!initSent) {
    initSent = true
    write({
      type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), cwd: process.cwd(),
      tools: [], mcp_servers: [], model: 'fake-model', permissionMode: 'default', slash_commands: [],
      apiKeySource: 'none', claude_code_version: '0.0.0-fake', output_style: 'default', agents: [], skills: [], plugins: []
    })
  }
}

async function reply(message) {
  ensureInit()
  let suffix = ''
  if (textOf(message).includes('[permission]')) {
    const answer = await askPermission('echo from-fake-claude')
    suffix = ` (${answer?.behavior ?? 'none'})`
  }
  const text = `echo: ${textOf(message)}${suffix}`
  write({
    type: 'assistant', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
    message: {
      id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'fake-model',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage
    }
  })
  write({
    type: 'result', subtype: 'success', is_error: false, session_id: sessionId, uuid: randomUUID(),
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: text, total_cost_usd: 0, usage,
    modelUsage: {}, permission_denials: []
  })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.type === 'control_request') answerControl(message)
  else if (message.type === 'control_response') {
    const settle = asks.get(message.response?.request_id)
    asks.delete(message.response?.request_id)
    settle?.(message.response?.response)
  } else if (message.type === 'user') void reply(message)
}).on('close', () => process.exit(0))
