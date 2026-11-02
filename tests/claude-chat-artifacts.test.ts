import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { artifactSources, chatArtifacts, emptyChatState, reduceChat, type ArtifactSources, type ChatEvent } from '../src/shared/claude-chat'
import { artifactPreviewKey, chromeUserAgent } from '../src/shared/artifact-preview'
import { artifactManifest, readArtifactFile } from '../src/main/claude-chat/artifact-files'

const sdk = (m: unknown): ChatEvent => ({ t: 'sdk', m, at: 1000 })

function call(id: string, input: Record<string, unknown>, name = 'Artifact'): ChatEvent {
  return sdk({ type: 'assistant', message: { id: `m_${id}`, content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null })
}

function result(id: string, content: string, extra: Record<string, unknown> = {}): ChatEvent {
  return sdk({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: null, ...extra })
}

const published = (path: string, url: string): string =>
  `Published ${path} at ${url} (Version 1, version id 1790840721-bb2c) Icon: "chart".\n\nLive subscription: arming in the background`

const URL_A = 'https://claude.ai/artifact/KjShbAL5S4KekE71xQhQTE'
const URL_B = 'https://claude.ai/artifact/GpNPuwVzAL3mA45kWRdruL'

describe('chatArtifacts', () => {
  it('lists published pages latest first, titled from the structured result', () => {
    const state = [
      call('a1', { file_path: '/tmp/usage-bars.html', description: 'Limit bars mockup' }),
      result('a1', published('/tmp/usage-bars.html', URL_A), { tool_use_result: { url: URL_A, title: 'Composer Limit Bars' } }),
      call('b1', { file_path: '/tmp/inbox-grouping.html' }),
      // A transcript line carries the structured result as toolUseResult.
      result('b1', published('/tmp/inbox-grouping.html', URL_B), { toolUseResult: { url: URL_B, title: 'Inbox Grouping' } })
    ].reduce(reduceChat, emptyChatState())

    expect(chatArtifacts(state.items)).toEqual([
      { url: URL_B, title: 'Inbox Grouping', description: undefined, toolUseId: 'b1', publishes: 1 },
      { url: URL_A, title: 'Composer Limit Bars', description: 'Limit bars mockup', toolUseId: 'a1', publishes: 1 }
    ])
  })

  it('folds republishes into one entry and falls back to the file name', () => {
    const state = [
      call('a1', { file_path: '/tmp/usage-bars.html' }),
      result('a1', published('/tmp/usage-bars.html', URL_A)),
      call('b1', { file_path: '/tmp/other.html' }),
      result('b1', published('/tmp/other.html', URL_B)),
      call('a2', { file_path: '/tmp/usage-bars.html', description: 'v2' }),
      result('a2', published('/tmp/usage-bars.html', URL_A))
    ].reduce(reduceChat, emptyChatState())

    expect(chatArtifacts(state.items).map((a) => [a.title, a.toolUseId, a.publishes, a.description])).toEqual([
      ['usage-bars', 'a2', 2, 'v2'],
      ['other', 'b1', 1, undefined]
    ])
  })

  it('ignores reads, errors and other tools', () => {
    const state = [
      call('r1', { action: 'read', url: URL_A }),
      result('r1', `<html>…</html> from ${URL_A}`),
      call('e1', { file_path: '/tmp/x.html' }),
      sdk({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: published('/tmp/x.html', URL_A), is_error: true }] }, parent_tool_use_id: null }),
      call('w1', { command: 'echo' }, 'Bash'),
      result('w1', published('/tmp/x.html', URL_A))
    ].reduce(reduceChat, emptyChatState())

    expect(chatArtifacts(state.items)).toEqual([])
  })
})

describe('artifactSources', () => {
  const sources = (events: ChatEvent[], url = URL_A) => artifactSources(events.reduce(reduceChat, emptyChatState()).items, url)

  it('folds the page and supporting files over every publish to the URL', () => {
    const got = sources([
      call('a1', { file_path: 'out/page.html', root: 'out', files: { 'app.js': 'app.js', 'img/logo.png': { from: 'logo.png', contentType: 'image/png' }, 'old.css': 'old.css' } }),
      result('a1', published('out/page.html', URL_A)),
      call('b1', { file_path: '/tmp/other.html', files: { 'x.js': 'x.js' } }),
      result('b1', published('/tmp/other.html', URL_B)),
      call('a2', { file_path: 'out/page2.html', url: URL_A, files: { 'old.css': null, 'lib.js': { artifact: URL_B, path: 'x.js' }, '../escape.js': 'e.js' } }),
      result('a2', published('out/page2.html', URL_A))
    ])
    expect(got).toEqual({
      page: { from: 'out/page2.html' },
      files: { 'app.js': { from: 'app.js', root: 'out' }, 'img/logo.png': { from: 'logo.png', root: 'out', contentType: 'image/png' } }
    })
  })

  it('takes a list of files at their own paths', () => {
    const got = sources([
      call('a1', { file_path: '/s/page.html', files: [{ path: 'style.css' }, { path: './data/rows.json' }, { path: 'shared.js', artifact: URL_B }] }),
      result('a1', published('/s/page.html', URL_A))
    ])
    expect(got).toEqual({ page: { from: '/s/page.html' }, files: { 'style.css': { from: 'style.css' }, 'data/rows.json': { from: './data/rows.json' } } })
  })

  it('has no local copy for typed artifacts, Markdown pages or other chats', () => {
    expect(sources([call('a1', { type_url: 'https://claude.ai/t', title: 'Deck' }), result('a1', published('deck', URL_A))])).toBeInstanceOf(Error)
    expect(sources([call('a1', { file_path: '/s/notes.md' }), result('a1', published('/s/notes.md', URL_A))])).toBeInstanceOf(Error)
    expect(sources([call('a1', { file_path: '/s/p.html' }), result('a1', published('/s/p.html', URL_A))], URL_B)).toBeInstanceOf(Error)
  })
})

describe('claude-artifacts MCP publishes', () => {
  const MCP = 'mcp__claude-artifacts__'
  const mcpResult = (url: string, title: string): string =>
    `${JSON.stringify({ slug: 'x', title, url, version: '1793609751-fa33', read: 'owner' })}\nOnce this session's watch on this artifact connects…`
  const reduce = (events: ChatEvent[]) => events.reduce(reduceChat, emptyChatState()).items

  it('lists a publish_files page and finds its local files', () => {
    const items = reduce([
      call('m1', { files: [{ as: 'index.html', path: '/s/themes.html' }, { as: 'app.js', path: '/s/app.js' }], title: 'Sidebar Themes' }, `${MCP}publish_files`),
      result('m1', mcpResult(URL_A, 'Sidebar Themes')),
      call('m2', { slug: 'x', base_version: 'v', files: [{ as: 'more.css', path: '/s/more.css' }], remove: ['app.js'] }, `${MCP}publish_files`),
      result('m2', mcpResult(URL_A, 'Sidebar Themes')),
      call('m3', { slug: 'x', base_version: 'v', edits: [{ old_text: 'Dark', new_text: 'Night' }] }, `${MCP}edit_version`),
      result('m3', mcpResult(URL_A, 'Sidebar Themes'))
    ])
    expect(chatArtifacts(items).map((a) => [a.url, a.title, a.publishes])).toEqual([[URL_A, 'Sidebar Themes', 3]])
    expect(artifactSources(items, URL_A)).toEqual({
      page: { from: '/s/themes.html', edits: [{ old: 'Dark', new: 'Night' }] },
      files: { 'more.css': { from: '/s/more.css' } }
    })
  })

  it('has no local copy for a page sent inline with publish_version', () => {
    const items = reduce([
      call('m1', { content: '<!DOCTYPE html><p>hi</p>', title: 'Inline' }, `${MCP}publish_version`),
      result('m1', mcpResult(URL_A, 'Inline'))
    ])
    expect(chatArtifacts(items).map((a) => a.title)).toEqual(['Inline'])
    expect(artifactSources(items, URL_A)).toBeInstanceOf(Error)
  })

  it('ignores reads and other MCP servers', () => {
    const items = reduce([
      call('r1', { slug: URL_A }, `${MCP}read_artifact`),
      result('r1', mcpResult(URL_A, 'Read')),
      call('o1', { files: [] }, 'mcp__other__publish_files'),
      result('o1', mcpResult(URL_B, 'Other'))
    ])
    expect(chatArtifacts(items)).toEqual([])
  })
})

describe('readArtifactFile', () => {
  it('replays edit_version edits on the local file, skipping ones already there', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-'))
    fs.writeFileSync(path.join(dir, 'p.html'), '<h1>Dark</h1><p>Light</p>')
    const page = await readArtifactFile({ page: { from: 'p.html', edits: [{ old: 'Dark', new: 'Night' }, { old: 'gone', new: 'x' }] }, files: {} }, '', { cwd: dir })
    expect(Buffer.from(page.data, 'base64').toString()).toBe('<h1>Night</h1><p>Light</p>')
  })

  it('reads only the files the publishes named, resolved from the chat directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-'))
    fs.mkdirSync(path.join(dir, 'out'))
    fs.writeFileSync(path.join(dir, 'out', 'page.html'), '<h1>hi</h1>')
    fs.writeFileSync(path.join(dir, 'out', 'app.js'), 'go()')
    const s: ArtifactSources = { page: { from: 'out/page.html' }, files: { 'app.js': { from: 'app.js', root: 'out' } } }
    expect(artifactManifest(s)).toEqual(['', 'app.js'])
    const page = await readArtifactFile(s, '', { cwd: dir })
    expect(Buffer.from(page.data, 'base64').toString()).toBe('<h1>hi</h1>')
    const js = await readArtifactFile(s, 'app.js', { cwd: dir })
    expect(Buffer.from(js.data, 'base64').toString()).toBe('go()')
    await expect(readArtifactFile(s, 'out/page.html', { cwd: dir })).rejects.toThrow('not part of this artifact')
    await expect(readArtifactFile({ page: { from: 'gone.html' }, files: {} }, '', { cwd: dir })).rejects.toThrow('no longer there')
  })

  it('reads an ssh chat\'s file through one script', async () => {
    const scripts: string[] = []
    const file = await readArtifactFile({ page: { from: 'p.html' }, files: {} }, '', {
      cwd: '/home/me/proj',
      remoteExec: async (script) => { scripts.push(script); return `ok\n${Buffer.from('<p>').toString('base64')}\n` }
    })
    expect(scripts[0]).toContain("f='/home/me/proj/p.html'")
    expect(Buffer.from(file.data, 'base64').toString()).toBe('<p>')
  })
})

describe('artifact preview helpers', () => {
  it('keys a copy by its artifact id', () => {
    expect(artifactPreviewKey(URL_A)).toBe('kjshbal5s4kekE71xQhQTE'.toLowerCase())
    expect(artifactPreviewKey('https://claude.ai/code/artifact/0a1b-2c?x=1')).toBe('0a1b-2c')
  })

  it('passes for plain Chrome', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) devtool/0.6.1 Chrome/138.0.7204.97 Electron/37.2.0 Safari/537.36'
    expect(chromeUserAgent(ua)).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.97 Safari/537.36')
  })
})
