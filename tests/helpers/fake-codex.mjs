#!/usr/bin/env node
// A stand-in for `codex app-server`: just enough JSON-RPC for one chat turn.
// The turn runs one command (asking approval first), streams a reply, and ends.
// A thread id of "known" resumes with one past turn; anything else is unknown.
let buffer = ''
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const notify = (method, params) => send({ method, params })
const THREAD = 'thread-new'
let approvalId = 100
let pendingTurn = null

function runTurn(threadId, turnId, input) {
  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } })
  notify('item/started', { threadId, turnId, item: { type: 'userMessage', id: 'u-1', clientId: input.clientUserMessageId, content: input.input } })
  const command = { type: 'commandExecution', id: 'exec-1', command: '/bin/zsh -lc ls', status: 'inProgress', aggregatedOutput: null, exitCode: null }
  notify('item/started', { threadId, turnId, item: command })
  pendingTurn = { threadId, turnId, command }
  send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'exec-1', command: '/bin/zsh -lc ls', reason: 'listing' } })
}

function finishTurn(decision) {
  const { threadId, turnId, command } = pendingTurn
  pendingTurn = null
  const accepted = decision === 'accept' || decision === 'acceptForSession'
  notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: 'exec-1', delta: 'a.txt\n' })
  notify('item/completed', { threadId, turnId, item: { ...command, status: accepted ? 'completed' : 'declined', aggregatedOutput: accepted ? 'a.txt\n' : '', exitCode: accepted ? 0 : null } })
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: 'Done' })
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: '.' })
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'msg-1', text: 'Done.' } })
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: 1000, outputTokens: 20 }, total: {}, modelContextWindow: 200000 } })
  notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null } } })
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } })
}

function handle(message) {
  const { id, method, params } = message
  if (method === undefined && id === approvalId && pendingTurn) return finishTurn(message.result?.decision)
  switch (method) {
    case 'initialize': return send({ id, result: { userAgent: 'fake' } })
    case 'initialized': return
    case 'thread/resume':
      if (params.threadId !== 'known') return send({ id, error: { code: -32600, message: 'thread not found' } })
      return send({ id, result: { thread: { id: 'known', turns: [{ id: 't0', status: 'completed', items: [
        { type: 'userMessage', id: 'h-u', content: [{ type: 'text', text: 'earlier question' }] },
        { type: 'agentMessage', id: 'h-a', text: 'earlier answer' }
      ] }] }, model: 'gpt-x', reasoningEffort: 'medium', cwd: params.cwd } })
    case 'thread/start':
      process.stderr.write(`start sandbox=${params.sandbox} approval=${params.approvalPolicy}\n`)
      return send({ id, result: { thread: { id: THREAD, turns: [] }, model: 'gpt-x', reasoningEffort: 'medium', cwd: params.cwd } })
    case 'model/list':
      return send({ id, result: { data: [{ id: 'gpt-x', displayName: 'GPT X', description: 'fast', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] } })
    case 'turn/start':
      send({ id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
      return runTurn(params.threadId, 'turn-1', params)
    case 'turn/interrupt':
      return send({ id, result: {} })
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown ${method}` } })
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
