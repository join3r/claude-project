#!/usr/bin/env node
// A stand-in for `pi --mode rpc`: one prompt runs one bash tool call and a reply.
// Session id "known" has one past exchange.
const args = process.argv.slice(2)
const sessionId = args[args.indexOf('--session-id') + 1]
let buffer = ''
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const ok = (command, id, data) => send({ type: 'response', id, command, success: true, ...(data === undefined ? {} : { data }) })

const history = sessionId === 'known'
  ? [
      { role: 'user', content: 'earlier question', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'h-call', name: 'read', arguments: { path: 'notes.md' } }], stopReason: 'toolUse', timestamp: 2 },
      { role: 'toolResult', toolCallId: 'h-call', toolName: 'read', content: [{ type: 'text', text: 'notes' }], isError: false, timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], stopReason: 'stop', timestamp: 4 }
    ]
  : []

function runPrompt(message) {
  send({ type: 'agent_start' })
  send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: message }], timestamp: 10 } })
  const call = { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }
  send({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 11 } })
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Let me look' } })
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: call } })
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me look' }, call], stopReason: 'toolUse', timestamp: 11 } })
  send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } })
  send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.txt' }] }, isError: false })
  send({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 12 } })
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Found ' } })
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a.txt' } })
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Found a.txt' }], stopReason: 'stop', timestamp: 12 } })
  send({ type: 'agent_end', messages: [], willRetry: false })
  send({ type: 'agent_settled' })
}

function handle(command) {
  const { id, type } = command
  switch (type) {
    case 'get_messages': return ok(type, id, { messages: history })
    case 'get_state': return ok(type, id, { model: { id: 'm1', provider: 'prov' }, thinkingLevel: 'medium', isStreaming: false })
    case 'get_available_models': return ok(type, id, { models: [{ id: 'm1', name: 'Model One', provider: 'prov', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }] })
    case 'get_commands': return ok(type, id, { commands: [{ name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' }] })
    case 'get_session_stats': return ok(type, id, { contextUsage: { tokens: 5000, contextWindow: 100000, percent: 5 }, cost: 0.12 })
    case 'set_model': return ok(type, id, { id: command.modelId, provider: command.provider })
    case 'set_thinking_level': return ok(type, id)
    case 'abort': return ok(type, id)
    case 'prompt':
      ok(type, id)
      return runPrompt(command.message)
    default:
      send({ type: 'response', id, command: type, success: false, error: `unknown ${type}` })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
