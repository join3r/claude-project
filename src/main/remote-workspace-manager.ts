import { execFile } from 'child_process'
import type { SshConfig, WorkspaceCreateRequest, WorkspaceDeleteRequest, WorkspaceListBranchesRequest } from '../shared/types'

type RemoteWorkspaceResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export class RemoteWorkspaceManager {
  private execFileAsync(command: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout }, (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      })
    })
  }

  private shellQuote(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'"
  }

  private async runRemote<T>(
    socketPath: string,
    projectId: string,
    sshConfig: SshConfig,
    payload: Record<string, unknown>,
    script: string
  ): Promise<T> {
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    const wrappedScript = `
import base64, json

payload = json.loads(base64.b64decode('${payloadB64}').decode())

${script}
`.trim()

    const sshArgs = [
      '-S', socketPath,
      `${sshConfig.username}@${sshConfig.host}`,
      `python3 -c ${this.shellQuote(wrappedScript)}`
    ]

    let stdout: string
    try {
      const result = await this.execFileAsync('ssh', sshArgs, 10000)
      stdout = result.stdout.trim()
    } catch (error) {
      throw new Error(`Remote workspace operation failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    let parsed: RemoteWorkspaceResponse<T>
    try {
      parsed = JSON.parse(stdout) as RemoteWorkspaceResponse<T>
    } catch {
      throw new Error(`Remote workspace operation returned invalid JSON for ${projectId}`)
    }

    if (!parsed.ok) {
      throw new Error(parsed.error)
    }

    return parsed.data
  }

  async listBranches(socketPath: string, request: WorkspaceListBranchesRequest & { projectId: string; sshConfig: SshConfig }): Promise<string[]> {
    return this.runRemote<string[]>(
      socketPath,
      request.projectId,
      request.sshConfig,
      { projectDir: request.projectDir },
      `
import subprocess

try:
    repo_root = subprocess.run(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=payload['projectDir'],
        capture_output=True,
        text=True,
        timeout=5,
        check=True
    ).stdout.strip()
    branches = subprocess.run(
        ['git', 'branch', '--format=%(refname:short)'],
        cwd=repo_root,
        capture_output=True,
        text=True,
        timeout=5,
        check=True
    ).stdout.splitlines()
    print(json.dumps({'ok': True, 'data': [b for b in branches if b]}))
except Exception as err:
    print(json.dumps({'ok': False, 'error': str(err)}))
`
    )
  }

  async create(
    socketPath: string,
    request: WorkspaceCreateRequest & { projectId: string; sshConfig: SshConfig }
  ): Promise<{ worktreePath: string; branchName: string; relativeProjectPath: string }> {
    return this.runRemote(
      socketPath,
      request.projectId,
      request.sshConfig,
      {
        projectDir: request.projectDir,
        name: request.name,
        baseBranch: request.baseBranch
      },
      `
import os, subprocess

try:
    repo_root = subprocess.run(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=payload['projectDir'],
        capture_output=True,
        text=True,
        timeout=5,
        check=True
    ).stdout.strip()
    try:
        subprocess.run(
            ['git', 'check-ref-format', '--branch', payload['name']],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
            check=True
        )
    except Exception:
        raise RuntimeError(f'Invalid branch name: "{payload["name"]}"')

    worktree_path = os.path.join(repo_root, '.worktrees', payload['name'])
    try:
        subprocess.run(
            ['git', 'worktree', 'add', worktree_path, '-b', payload['name'], payload['baseBranch']],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
            check=True
        )
    except subprocess.CalledProcessError as err:
        msg = err.stderr.strip() or err.stdout.strip() or str(err)
        if 'already exists' in msg:
            raise RuntimeError(f'Branch "{payload["name"]}" already exists')
        raise RuntimeError(f'Failed to create workspace: {msg}')

    relative_project_path = os.path.relpath(os.path.realpath(payload['projectDir']), os.path.realpath(repo_root))
    if relative_project_path == '.':
        relative_project_path = ''

    print(json.dumps({
        'ok': True,
        'data': {
            'worktreePath': worktree_path,
            'branchName': payload['name'],
            'relativeProjectPath': relative_project_path
        }
    }))
except Exception as err:
    print(json.dumps({'ok': False, 'error': str(err)}))
`
    )
  }

  async delete(
    socketPath: string,
    request: WorkspaceDeleteRequest & { projectId: string; sshConfig: SshConfig }
  ): Promise<{ status: 'ok' | 'uncommitted' | 'unmerged' | 'uncommitted-and-unmerged'; baseBranch?: string }> {
    return this.runRemote(
      socketPath,
      request.projectId,
      request.sshConfig,
      {
        projectDir: request.projectDir,
        worktreePath: request.worktreePath,
        branchName: request.branchName,
        baseBranch: request.baseBranch,
        force: !!request.force,
        keepBranch: !!request.keepBranch
      },
      `
import os, shutil, subprocess

try:
    repo_root = subprocess.run(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=payload['projectDir'],
        capture_output=True,
        text=True,
        timeout=5,
        check=True
    ).stdout.strip()

    if not payload.get('force'):
        has_uncommitted = False
        try:
            status_stdout = subprocess.run(
                ['git', '-C', payload['worktreePath'], 'status', '--porcelain'],
                capture_output=True,
                text=True,
                timeout=5,
                check=True
            ).stdout.strip()
            has_uncommitted = len(status_stdout) > 0
        except Exception:
            has_uncommitted = False

        is_unmerged = False
        try:
            merged_stdout = subprocess.run(
                ['git', '-C', repo_root, 'branch', '--merged', payload['baseBranch']],
                capture_output=True,
                text=True,
                timeout=5,
                check=True
            ).stdout
            merged_branches = [line.strip().lstrip('*+ ').strip() for line in merged_stdout.splitlines()]
            is_unmerged = payload['branchName'] not in merged_branches
        except Exception:
            is_unmerged = False

        if has_uncommitted and is_unmerged:
            print(json.dumps({'ok': True, 'data': {'status': 'uncommitted-and-unmerged', 'baseBranch': payload['baseBranch']}}))
            raise SystemExit(0)
        if has_uncommitted:
            print(json.dumps({'ok': True, 'data': {'status': 'uncommitted'}}))
            raise SystemExit(0)
        if is_unmerged:
            print(json.dumps({'ok': True, 'data': {'status': 'unmerged', 'baseBranch': payload['baseBranch']}}))
            raise SystemExit(0)

    try:
        subprocess.run(
            ['git', '-C', repo_root, 'worktree', 'remove', '--force', payload['worktreePath']],
            capture_output=True,
            text=True,
            timeout=10,
            check=True
        )
    except Exception:
        if os.path.exists(payload['worktreePath']):
            shutil.rmtree(payload['worktreePath'], ignore_errors=True)
        subprocess.run(
            ['git', '-C', repo_root, 'worktree', 'prune'],
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )

    if not payload.get('keepBranch'):
        subprocess.run(
            ['git', '-C', repo_root, 'branch', '-D', payload['branchName']],
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )

    print(json.dumps({'ok': True, 'data': {'status': 'ok'}}))
except SystemExit:
    raise
except Exception as err:
    print(json.dumps({'ok': False, 'error': str(err)}))
`
    )
  }
}
