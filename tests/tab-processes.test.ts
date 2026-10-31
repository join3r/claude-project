import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import { environHasTag, pidsWithTag, reapTabProcesses, TAB_OWNER_ENV } from '../src/main/tab-processes'

describe('pidsWithTag', () => {
  const ps = [
    '  101 /usr/bin/node server.js PATH=/bin DEVTOOL_TAB_OWNER=tab-1 HOME=/u',
    '  102 electron . HOME=/u DEVTOOL_TAB_OWNER=tab-1',
    '  103 vite DEVTOOL_TAB_OWNER=tab-12 HOME=/u',
    '  104 zsh HOME=/u',
    '  105 claude DEVTOOL_TAB_OWNER=tab-1'
  ].join('\n')

  it('matches the exact tab id, anywhere in the environment', () => {
    expect(pidsWithTag(ps, 'tab-1', [])).toEqual([101, 102, 105])
    expect(pidsWithTag(ps, 'tab-12', [])).toEqual([103])
  })

  it('leaves out the excluded pids', () => {
    expect(pidsWithTag(ps, 'tab-1', [105])).toEqual([101, 102])
  })
})

describe('environHasTag', () => {
  it('reads a NUL-separated environ', () => {
    expect(environHasTag(`HOME=/u\0${TAB_OWNER_ENV}=tab-1\0`, 'tab-1')).toBe(true)
    expect(environHasTag(`HOME=/u\0${TAB_OWNER_ENV}=tab-12\0`, 'tab-1')).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('reapTabProcesses', () => {
  it('ends a detached process that carries the tab tag, and only that one', async () => {
    const tag = `reap-test-${process.pid}-${Date.now()}`
    const start = (env: NodeJS.ProcessEnv) => {
      // Not `sleep`: macOS hides a platform binary's environment from `ps`.
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore', env })
      child.unref()
      return child
    }
    const tagged = start({ ...process.env, [TAB_OWNER_ENV]: tag })
    const other = start({ ...process.env, [TAB_OWNER_ENV]: `${tag}-other` })
    const exited = new Promise(resolve => tagged.once('exit', resolve))
    try {
      await reapTabProcesses(tag, () => {})
      await exited
      expect(() => process.kill(other.pid!, 0)).not.toThrow()
    } finally {
      try { process.kill(tagged.pid!, 'SIGKILL') } catch { /* gone */ }
      try { process.kill(other.pid!, 'SIGKILL') } catch { /* gone */ }
    }
  }, 15_000)
})
