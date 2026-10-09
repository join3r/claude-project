import { describe, expect, it } from 'vitest'
import { composerCommands, emptyChatState, parseLoginCommand, reduceChat, TERMINAL_ONLY_COMMANDS } from '../src/shared/claude-chat'
import { accountFromStatus, loginArgs, loginUrlFrom, outputTail, startLogin } from '../src/main/claude-chat/auth'
import { chatCommands } from '../src/main/mobile/chat-bridge'

const CLI_OUTPUT = [
  'Opening browser to sign in…',
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y",
  'Paste code here if prompted > '
].join('\n')

describe('chat /login', () => {
  it('reads the method from /login [console|sso]', () => {
    expect(parseLoginCommand('/login')).toBe('claudeai')
    expect(parseLoginCommand('  /login console ')).toBe('console')
    expect(parseLoginCommand('/login SSO')).toBe('sso')
    expect(parseLoginCommand('/logout')).toBeNull()
    expect(parseLoginCommand('/login a b')).toBeNull()
    expect(loginArgs('claudeai')).toEqual(['auth', 'login'])
    expect(loginArgs('console')).toEqual(['auth', 'login', '--console'])
  })

  it('runs /login and /logout itself instead of handing them to a terminal', () => {
    expect(TERMINAL_ONLY_COMMANDS.has('login')).toBe(false)
    expect(TERMINAL_ONLY_COMMANDS.has('logout')).toBe(false)
    expect(composerCommands([]).map((command) => command.name)).toEqual(['btw', 'permissions', 'login', 'logout'])
  })

  it('keeps /login and /logout off the phone, or terminal only when the CLI lists them', () => {
    expect(chatCommands(emptyChatState()).commands.map((command) => command.name)).toEqual(['btw', 'permissions'])
    const listed = chatCommands({ ...emptyChatState(), commands: [{ name: 'login', description: 'Sign in' }] }).commands
    expect(listed.find((command) => command.name === 'login')).toEqual({ name: 'login', description: 'Sign in', terminalOnly: true })
  })

  it('finds the sign-in page and the account', () => {
    expect(loginUrlFrom(CLI_OUTPUT)).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y')
    expect(loginUrlFrom('Opening browser to sign in…')).toBeNull()
    expect(accountFromStatus('{"loggedIn":true,"email":"a@b.c","orgName":"Org"}')).toBe('a@b.c (Org)')
    expect(accountFromStatus('{"loggedIn":true,"authMethod":"api_key"}')).toBe('api_key')
    expect(accountFromStatus('{"loggedIn":false}')).toBeNull()
    expect(accountFromStatus('not json')).toBeNull()
    expect(outputTail('a\n\n\x1b[31mb\x1b[0m\nc\nd\ne\n')).toBe('b\nc\nd\ne')
  })

  it('keeps the sign-in card across /clear and drops it when dismissed', () => {
    let state = reduceChat(emptyChatState(), { t: 'login', login: { status: 'running', method: 'claudeai' } })
    state = reduceChat(state, { t: 'sdk', m: { type: 'conversation_reset' } })
    expect(state.login).toEqual({ status: 'running', method: 'claudeai' })
    state = reduceChat(state, { t: 'login', login: null })
    expect('login' in state).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('passes a pasted code to claude auth login and reports how it ended', async () => {
    const script = `printf '%s\\n' 'visit: https://example.com/auth'; read code; [ "$code" = abc ] && exit 0; echo "bad code $code" >&2; exit 1`
    const outputs: string[] = []
    const ok = startLogin({ file: '/bin/sh', args: ['-c', script] }, (output) => outputs.push(output))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(loginUrlFrom(outputs[outputs.length - 1] ?? '')).toBe('https://example.com/auth')
    ok.submitCode(' abc ')
    expect(await ok.done).toMatchObject({ ok: true })

    const bad = startLogin({ file: '/bin/sh', args: ['-c', script] }, () => {})
    bad.submitCode('nope')
    const result = await bad.done
    expect(result.ok).toBe(false)
    expect(outputTail(result.output)).toMatch(/bad code nope/)
  })

  it.skipIf(process.platform === 'win32')('stops a sign-in when cancelled or timed out', async () => {
    const cancelled = startLogin({ file: '/bin/sh', args: ['-c', 'sleep 5'] }, () => {})
    cancelled.cancel()
    expect(await cancelled.done).toEqual({ ok: false, output: 'Cancelled.' })
    const timedOut = startLogin({ file: '/bin/sh', args: ['-c', 'sleep 5'] }, () => {}, 50)
    expect(await timedOut.done).toEqual({ ok: false, output: 'Sign-in timed out.' })
  })
})
