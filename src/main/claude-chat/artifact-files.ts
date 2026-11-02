import fs from 'fs/promises'
import path from 'path'
import { ARTIFACT_FILE_MAX_BYTES, type ArtifactPreviewFile } from '../../shared/artifact-preview'
import type { ArtifactSource, ArtifactSources } from '../../shared/claude-chat'
import { shellQuote } from '../ssh-connection-manager'

/** Where a chat's files are: its directory, and for an ssh project a way to run a script there. */
export interface ArtifactFileHost {
  cwd: string
  remoteExec?: (script: string) => Promise<string>
}

/** The published paths of an artifact's local copy: '' (the page) first. */
export function artifactManifest(sources: ArtifactSources): string[] {
  return ['', ...Object.keys(sources.files)]
}

const tooLarge = (published: string) =>
  new Error(`${published || 'The page'} is over ${ARTIFACT_FILE_MAX_BYTES / (1024 * 1024)} MB, too large for the local copy`)

/**
 * One file of an artifact's local copy, read from where the chat runs. Only the
 * files its Artifact calls named are reachable: `published` is looked up, never
 * joined onto a directory.
 */
export async function readArtifactFile(sources: ArtifactSources, published: string, host: ArtifactFileHost): Promise<ArtifactPreviewFile> {
  const source: ArtifactSource | undefined = published === '' ? sources.page : sources.files[published]
  if (!source) throw new Error(`${published} is not part of this artifact`)
  const contentType = source.contentType ? { contentType: source.contentType } : {}

  if (host.remoteExec) {
    const file = path.posix.resolve(host.cwd, source.root ?? '', source.from)
    const out = await host.remoteExec([
      `f=${shellQuote(file)}`,
      '[ -f "$f" ] || { echo missing; exit 0; }',
      `[ "$(wc -c < "$f")" -le ${ARTIFACT_FILE_MAX_BYTES} ] || { echo large; exit 0; }`,
      'echo ok; base64 < "$f" | tr -d "\\n"'
    ].join('\n'))
    const [status, data = ''] = out.split('\n')
    if (status === 'missing') throw new Error(`${file} is no longer there`)
    if (status === 'large') throw tooLarge(published)
    if (status !== 'ok') throw new Error(`Couldn't read ${file}`)
    return { path: published, data: withEdits(data.trim(), source.edits), ...contentType }
  }

  const file = path.resolve(host.cwd, source.root ?? '', source.from)
  let size: number
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    throw new Error(`${file} is no longer there`)
  }
  if (size > ARTIFACT_FILE_MAX_BYTES) throw tooLarge(published)
  return { path: published, data: withEdits((await fs.readFile(file)).toString('base64'), source.edits), ...contentType }
}

/**
 * Replay the edits claude.ai made after the file was sent. An edit whose text
 * isn't there exactly once is skipped: the file most likely has it already.
 */
function withEdits(base64: string, edits: ArtifactSource['edits']): string {
  if (!edits?.length) return base64
  let text = Buffer.from(base64, 'base64').toString('utf8')
  for (const edit of edits) {
    const at = text.indexOf(edit.old)
    if (at < 0 || text.indexOf(edit.old, at + 1) >= 0) continue
    text = text.slice(0, at) + edit.new + text.slice(at + edit.old.length)
  }
  return Buffer.from(text, 'utf8').toString('base64')
}
