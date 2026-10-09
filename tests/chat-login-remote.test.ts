import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeChatManager, type ChatManagerDeps } from '../src/main/claude-chat/chat-manager'
import type { ChatEvent } from '../src/shared/claude-chat'

/**
 * `/login` on a DevTool server (plan step 7, Step 0 note 5 C): the server's
 * chats sign in from the desktop, so the login asks for the pasted code
 * (`login.remote`) as an SSH project's does, though the chat itself is local
 * to the host.
 */

const managers: ClaudeChatManager[] = []
const dirs: string[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function manager(loginRemote: boolean | undefined) {
  const events: ChatEvent[] = []
  const fakeClaude = path.resolve('tests/helpers/fake-claude.mjs')
  const deps: ChatManagerDeps = {
    sendToClient: (_clientId, channel, _tabId, _seq, event) => { if (channel === 'chat-event') events.push(event as ChatEvent) },
    resolveLocalClaude: () => fakeClaude,
    localEnv: () => process.env,
    ensureSsh: async () => {},
    remoteCommand: () => { throw new Error('no ssh here') },
    bashSpawn: (config, command) => ({ file: '/bin/sh', args: ['-c', command], cwd: config.cwd }),
    // `claude auth login`: prints its page and waits for a code.
    claudeSpawn: (config) => ({ file: '/bin/sh', args: ['-c', 'echo "visit: https://example.com/auth"; read code'], cwd: config.cwd }),
    remoteExec: async () => '',
    onHook: () => {},
    onPromptResolved: () => {},
    onProcessChange: () => {},
    log: () => {},
    ...(loginRemote === undefined ? {} : { loginRemote })
  }
  const chats = new ClaudeChatManager(deps)
  managers.push(chats)
  return { chats, events }
}

async function loginOf(loginRemote: boolean | undefined): Promise<ChatEvent | undefined> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-login-'))
  dirs.push(cwd)
  const { chats, events } = manager(loginRemote)
  await chats.attach('link:desktop:win:1', 'tab-1', { cwd, sessionId: randomUUID(), projectId: 'p' })
  void chats.login('tab-1', 'claudeai')
  await expect.poll(() => events.some(e => e.t === 'login' && e.login?.url === 'https://example.com/auth'), { timeout: 10_000 }).toBe(true)
  chats.dismissLogin('tab-1')
  return events.find(e => e.t === 'login' && e.login)
}

describe.skipIf(process.platform === 'win32')('chat /login on a DevTool server', () => {
  it('asks for the pasted code on a server, whose browser isn\'t where the user is', async () => {
    expect(await loginOf(true)).toMatchObject({ t: 'login', login: { status: 'running', method: 'claudeai', remote: true } })
  }, 20_000)

  it('lets a desktop\'s own chat finish in the browser that opens', async () => {
    const login = await loginOf(undefined)
    expect(login).toMatchObject({ t: 'login', login: { status: 'running', method: 'claudeai' } })
    expect(login && login.t === 'login' ? login.login?.remote : 'x').toBeUndefined()
  }, 20_000)
})
