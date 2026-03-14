import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CodexSessionManager } from '../src/main/codex-session-manager'

describe('CodexSessionManager', () => {
  let rootDir: string
  let sharedHome: string
  let manager: CodexSessionManager

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-codex-tabs-'))
    sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-codex-home-'))
    manager = new CodexSessionManager(rootDir, sharedHome)
  })

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
    fs.rmSync(sharedHome, { recursive: true, force: true })
  })

  it('links shared Codex config into a per-tab home', () => {
    fs.writeFileSync(path.join(sharedHome, 'auth.json'), '{"token":"abc"}')
    fs.writeFileSync(path.join(sharedHome, 'config.toml'), 'model = "gpt-5"')
    fs.mkdirSync(path.join(sharedHome, 'skills'))

    const prepared = manager.prepareLocalTab('tab-1')

    expect(prepared.sessionId).toBeNull()
    expect(fs.lstatSync(path.join(prepared.home, 'auth.json')).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(prepared.home, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(prepared.home, 'skills')).isSymbolicLink()).toBe(true)
  })

  it('keeps volatile Codex state isolated per tab', () => {
    fs.writeFileSync(path.join(sharedHome, 'history.jsonl'), '{"id":"shared"}\n')
    fs.writeFileSync(path.join(sharedHome, 'session_index.jsonl'), '{"id":"shared"}\n')
    fs.writeFileSync(path.join(sharedHome, 'state_5.sqlite'), 'sqlite-bytes')

    const prepared = manager.prepareLocalTab('tab-1')

    expect(fs.existsSync(path.join(prepared.home, 'history.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(prepared.home, 'session_index.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(prepared.home, 'state_5.sqlite'))).toBe(false)
  })

  it('reads the latest isolated session id for a tab', () => {
    const prepared = manager.prepareLocalTab('tab-1')
    fs.writeFileSync(
      path.join(prepared.home, 'session_index.jsonl'),
      '{"id":"sess-old"}\n{"id":"sess-new"}\n'
    )

    const again = manager.prepareLocalTab('tab-1')

    expect(again.sessionId).toBe('sess-new')
  })

  it('reads the latest isolated session id without preparing again', () => {
    const prepared = manager.prepareLocalTab('tab-1')
    fs.writeFileSync(
      path.join(prepared.home, 'session_index.jsonl'),
      '{"id":"sess-old"}\n{"id":"sess-new"}\n'
    )

    expect(manager.readLocalTabSessionId('tab-1')).toBe('sess-new')
  })

  it('cleans up a local tab home', () => {
    const prepared = manager.prepareLocalTab('tab-1')
    expect(fs.existsSync(prepared.home)).toBe(true)

    manager.cleanupLocalTab('tab-1')

    expect(fs.existsSync(prepared.home)).toBe(false)
  })

  it('builds a remote prepare script for project-local tab homes', () => {
    const script = manager.buildRemotePrepareScript('/srv/app', 'tab-1')

    expect(script).toContain('/srv/app/.devtool/codex-tabs/tab-1')
    expect(script).toContain("os.path.expanduser('~/.codex')")
    expect(script).toContain("os.symlink(src, dst)")
    expect(script).toContain("session_index.jsonl")
    expect(script).toContain("sessionId")
  })

  it('builds a remote read-session script scoped to the tab home', () => {
    const script = manager.buildRemoteReadSessionScript('/srv/app', 'tab-1')

    expect(script).toContain('/srv/app/.devtool/codex-tabs/tab-1')
    expect(script).toContain('session_index.jsonl')
    expect(script).toContain("sessionId")
    expect(script).not.toContain("os.symlink")
  })

  it('builds a remote cleanup script scoped to the tab home', () => {
    const script = manager.buildRemoteCleanupScript('/srv/app', 'tab-1')

    expect(script).toContain('/srv/app/.devtool/codex-tabs/tab-1')
    expect(script).toContain('shutil.rmtree')
  })
})
