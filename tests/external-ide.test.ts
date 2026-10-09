import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  detectExternalEditors,
  envForExternalIde,
  isVsCodeFamilyEditor,
  openFolderInEditor,
  prepareOpenInIdeSpawn,
  prepareOpenRemoteSpawn,
  sshRemoteFolderUri,
  spawnOptionsForExternalIde,
  splitExtraArgs
} from '../src/main/external-ide'
import type { ExternalEditor } from '../src/shared/types'

const editor = (patch: Partial<ExternalEditor> = {}): ExternalEditor => ({
  id: 'e1',
  name: 'Cursor',
  command: 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe',
  extraArgs: '',
  ...patch
})

describe('splitExtraArgs', () => {
  it('splits on whitespace and drops empties', () => {
    expect(splitExtraArgs('  --new-window  --wait ')).toEqual(['--new-window', '--wait'])
    expect(splitExtraArgs('')).toEqual([])
  })
})

describe('detectExternalEditors', () => {
  const win = { platform: 'win32' as const, path: path.win32 }

  it('finds well-known Code.exe and Cursor.exe', () => {
    const local = 'C:\\Users\\me\\AppData\\Local'
    const code = path.win32.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe')
    const cursor = path.win32.join(local, 'Programs', 'cursor', 'Cursor.exe')
    const files = new Set([code.toLowerCase(), cursor.toLowerCase()])
    const found = detectExternalEditors({
      ...win,
      env: { LOCALAPPDATA: local, PATH: 'C:\\Windows' },
      existsSync: (filePath) => files.has(filePath.toLowerCase())
    })
    expect(found.map((item) => item.name).sort()).toEqual(['Cursor', 'Visual Studio Code'])
    expect(found.find((item) => item.name === 'Visual Studio Code')?.command.toLowerCase()).toBe(code.toLowerCase())
  })

  it('finds code and cursor on PATH on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const found = detectExternalEditors({
        platform,
        env: { PATH: '/usr/bin:/usr/local/bin' },
        existsSync: (candidate) => candidate === '/usr/local/bin/code' || candidate === '/usr/local/bin/cursor'
      })
      expect(found.map((item) => item.command).sort()).toEqual(['/usr/local/bin/code', '/usr/local/bin/cursor'])
    }
  })

  it('finds code.cmd on PATH when no Code.exe is installed', () => {
    const found = detectExternalEditors({
      ...win,
      env: { PATH: 'C:\\npm-global', PATHEXT: '.EXE;.CMD' },
      existsSync: (candidate) => candidate.toLowerCase() === 'c:\\npm-global\\code.cmd'
    })
    expect(found[0].name).toBe('Visual Studio Code')
    expect(found[0].command.toLowerCase()).toBe('c:\\npm-global\\code.cmd')
  })

  it('does not treat PATH cursor.cmd as the Cursor IDE', () => {
    const found = detectExternalEditors({
      ...win,
      env: { PATH: 'C:\\cursor-cli', PATHEXT: '.EXE;.CMD' },
      existsSync: (candidate) => candidate.toLowerCase() === 'c:\\cursor-cli\\cursor.cmd'
    })
    expect(found).toEqual([])
  })
})

describe('prepareOpenInIdeSpawn', () => {
  const win = { platform: 'win32' as const, path: path.win32 }
  const folder = 'C:\\Repos\\DevTool'

  it('spawns the GUI .exe directly with extra args then the folder', () => {
    const prepared = prepareOpenInIdeSpawn(
      editor({ extraArgs: '--new-window' }),
      folder,
      {
        ...win,
        existsSync: (filePath) =>
          filePath === folder || filePath.toLowerCase() === editor().command.toLowerCase(),
        statSync: (filePath) => ({ isDirectory: () => filePath === folder })
      }
    )
    expect(prepared.file).toBe(editor().command)
    expect(prepared.args).toEqual(['--new-window', folder])
  })

  it('does not rewrite Code.exe to bin/code.cmd', () => {
    const exe = 'C:\\VS\\Code.exe'
    const cli = 'C:\\VS\\bin\\code.cmd'
    const prepared = prepareOpenInIdeSpawn(
      editor({ name: 'Visual Studio Code', command: exe }),
      folder,
      {
        ...win,
        existsSync: (filePath) => {
          const n = filePath.toLowerCase()
          return n === folder.toLowerCase() || n === exe.toLowerCase() || n === cli.toLowerCase()
        },
        statSync: (filePath) => ({ isDirectory: () => filePath === folder })
      }
    )
    expect(prepared.file).toBe(exe)
    expect(prepared.args).toEqual([folder])
  })

  it('rewrites cursor.cmd to Cursor.exe so Agents CLI is not launched', () => {
    const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe'
    const cli = 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd'
    const prepared = prepareOpenInIdeSpawn(
      editor({ command: cli }),
      folder,
      {
        ...win,
        existsSync: (filePath) => {
          const n = filePath.toLowerCase()
          return n === folder.toLowerCase() || n === exe.toLowerCase() || n === cli.toLowerCase()
        },
        statSync: (filePath) => ({ isDirectory: () => filePath === folder })
      }
    )
    expect(prepared.file).toBe(exe)
    expect(prepared.args).toEqual([folder])
  })

  it('wraps .cmd shims with cmd.exe', () => {
    const cmdPath = 'C:\\npm-global\\code.cmd'
    const prepared = prepareOpenInIdeSpawn(
      editor({ command: cmdPath }),
      folder,
      {
        ...win,
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        existsSync: (filePath) => filePath === folder || filePath.toLowerCase() === cmdPath.toLowerCase(),
        statSync: (filePath) => ({ isDirectory: () => filePath === folder })
      }
    )
    expect(prepared.file.toLowerCase()).toBe('c:\\windows\\system32\\cmd.exe')
    expect(prepared.args[0]).toBe('/d')
    expect(prepared.args.at(-1)).toBe(folder)
    expect(prepared.args).toContain(cmdPath)
    expect(prepared.args).not.toContain('--')
  })

  it('rejects a missing folder', () => {
    expect(() =>
      prepareOpenInIdeSpawn(editor(), folder, {
        ...win,
        existsSync: () => false
      })
    ).toThrow(/Folder does not exist/)
  })
})

describe('openFolderInEditor', () => {
  it('spawns detached and unrefs', () => {
    const unref = vi.fn()
    const spawn = vi.fn(() => ({ unref }))
    const folder = 'C:\\Repos\\DevTool'
    const exe = editor().command
    openFolderInEditor(editor(), folder, {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\me' },
      existsSync: (filePath) => filePath === folder || filePath.toLowerCase() === exe.toLowerCase(),
      statSync: (filePath) => ({ isDirectory: () => filePath === folder }),
      spawn: spawn as never
    })
    expect(spawn).toHaveBeenCalledWith(
      exe,
      [folder],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: path.win32.dirname(exe)
      })
    )
    expect(unref).toHaveBeenCalled()
  })

  it('hides only the cmd.exe console when wrapping a .cmd shim', () => {
    const options = spawnOptionsForExternalIde(
      { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'code.cmd', 'C:\\repo'] },
      { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\me' } }
    )
    expect(options.windowsHide).toBe(true)
    expect(options.cwd).toBe('C:\\Users\\me')
  })

  it('does not hide Code.exe / Cursor.exe (SW_HIDE would hide the new window)', () => {
    const exe = editor().command
    const options = spawnOptionsForExternalIde(
      { file: exe, args: ['C:\\repo'] },
      { platform: 'win32' }
    )
    expect(options.windowsHide).toBe(false)
    expect(options.cwd).toBe(path.win32.dirname(exe))
  })

  it('strips Electron env so VS Code is not launched as a nested Electron', () => {
    const env = envForExternalIde({
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      CHROME_CRASHPAD_PIPE_NAME: 'pipe',
      VSCODE_PID: '123',
      KEEP_ME: 'yes'
    })
    expect(env.PATH).toBe('C:\\Windows')
    expect(env.KEEP_ME).toBe('yes')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.VSCODE_PID).toBeUndefined()
    expect(env.CHROME_CRASHPAD_PIPE_NAME).toBeUndefined()
  })
})

describe('opening a DevTool server\'s folder over SSH (plan step 9)', () => {
  const mac = { platform: 'darwin' as const, env: { PATH: '/usr/bin' }, existsSync: (p: string) => p.startsWith('/Applications/') }

  it('builds the vscode-remote URI, percent-encoding each path segment', () => {
    expect(sshRemoteFolderUri('devtool-box', '/home/dev/my app#1')).toBe('vscode-remote://ssh-remote+devtool-box/home/dev/my%20app%231')
    expect(() => sshRemoteFolderUri('devtool-box', 'relative')).toThrow(/absolute/)
    expect(() => sshRemoteFolderUri('bad host', '/x')).toThrow()
  })

  it('opens VS Code and Cursor with --folder-uri, extra args first', () => {
    const code = { id: 'c', name: 'Visual Studio Code', command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', extraArgs: '--new-window' }
    expect(prepareOpenRemoteSpawn(code, 'devtool-box', '/srv/app', mac)).toEqual({
      file: code.command,
      args: ['--new-window', '--folder-uri', 'vscode-remote://ssh-remote+devtool-box/srv/app']
    })
    const cursor = { id: 'u', name: 'Cursor', command: '/Applications/Cursor.app/Contents/MacOS/Cursor', extraArgs: '' }
    expect(prepareOpenRemoteSpawn(cursor, 'devtool-box', '/srv/app', mac).args).toEqual(['--folder-uri', 'vscode-remote://ssh-remote+devtool-box/srv/app'])
  })

  it('refuses editors without Remote - SSH', () => {
    expect(isVsCodeFamilyEditor({ name: 'Cursor', command: 'cursor' })).toBe(true)
    expect(isVsCodeFamilyEditor({ name: 'My editor', command: '/usr/local/bin/codium' })).toBe(true)
    expect(isVsCodeFamilyEditor({ name: 'Zed', command: '/usr/local/bin/zed' })).toBe(false)
    expect(isVsCodeFamilyEditor({ name: 'Xcode', command: '/usr/bin/xed' })).toBe(false)
    expect(() => prepareOpenRemoteSpawn({ id: 'z', name: 'Zed', command: '/usr/local/bin/zed', extraArgs: '' }, 'devtool-box', '/srv', mac)).toThrow(/VS Code and Cursor/)
  })
})
