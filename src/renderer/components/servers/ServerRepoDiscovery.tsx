import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch } from 'lucide-react'
import type { HostRepoDiscovery } from '../../../shared/host-fs'
import { HelperText, LinkBtn, PrimaryButton } from '../ui'

export interface ServerRepoDiscoveryProps {
  serverId: string
  /** Folders that already are projects on this server: listed, but not offered again. */
  existingDirectories: ReadonlySet<string>
  /** The repos picked, as projects to add. */
  onAdd: (repos: Array<{ name: string; directory: string }>) => void
  /** Shown left of the Add button (a Cancel or Skip). */
  secondary?: React.ReactNode
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

/**
 * "Found on this server": the git repos under the server user's home (three
 * levels down, heavy folders skipped, a few seconds at most), with a checkbox
 * each, added as projects in one go. Used by Add server project, and meant for
 * right after a server is paired too.
 */
export default function ServerRepoDiscovery({ serverId, existingDirectories, onAdd, secondary }: ServerRepoDiscoveryProps): React.ReactElement {
  const [result, setResult] = useState<HostRepoDiscovery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const scan = useCallback(() => {
    setResult(null)
    setError(null)
    let cancelled = false
    window.api.serverDiscoverRepos(serverId)
      .then((found) => { if (!cancelled) setResult(found) })
      .catch((err: unknown) => { if (!cancelled) setError(errorText(err)) })
    return () => { cancelled = true }
  }, [serverId])

  useEffect(() => scan(), [scan])

  const offered = useMemo(
    () => (result?.repos ?? []).filter(repo => !existingDirectories.has(repo.path)),
    [result, existingDirectories]
  )

  const toggle = (path: string): void => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const add = (): void => {
    const repos = offered.filter(repo => picked.has(repo.path)).map(repo => ({ name: repo.name, directory: repo.path }))
    if (repos.length > 0) onAdd(repos)
  }

  return (
    <div className="flex flex-col gap-2 min-h-0" data-testid="server-repo-discovery">
      {error ? (
        <HelperText>Couldn't look for repositories: {error} <LinkBtn onClick={scan}>Look again</LinkBtn></HelperText>
      ) : !result ? (
        <HelperText>Looking for git repositories…</HelperText>
      ) : result.repos.length === 0 ? (
        <HelperText>No git repositories under {result.root}. <LinkBtn onClick={scan}>Look again</LinkBtn></HelperText>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-sm text-text-muted">
            <span className="truncate min-w-0" title={result.root}>Under {result.root}</span>
            {offered.length > 1 && (
              <button
                type="button"
                className="bg-transparent border-0 p-0 text-sm text-text-muted hover:text-text cursor-pointer shrink-0"
                onClick={() => setPicked(prev => prev.size === offered.length ? new Set() : new Set(offered.map(repo => repo.path)))}
              >
                {picked.size === offered.length ? 'Select none' : 'Select all'}
              </button>
            )}
          </div>
          <div className="flex flex-col max-h-[280px] overflow-y-auto rounded-md border border-border bg-field">
            {result.repos.map(repo => {
              const added = existingDirectories.has(repo.path)
              return (
                <label
                  key={repo.path}
                  className={`flex items-center gap-2 px-2.5 py-1.5 text-base border-b border-hair last:border-b-0 ${added ? 'text-text-subtle' : 'text-text cursor-pointer hover:bg-surface-3'}`}
                >
                  <input
                    type="checkbox"
                    className="accent-(--color-accent) shrink-0"
                    disabled={added}
                    checked={added || picked.has(repo.path)}
                    onChange={() => toggle(repo.path)}
                  />
                  <GitBranch size={12} className="shrink-0 text-text-subtle" />
                  <span className="font-semibold shrink-0">{repo.name}</span>
                  <span className="text-sm text-text-subtle truncate font-mono" title={repo.path}>{repo.path}</span>
                  {added && <span className="ml-auto text-2xs shrink-0">added</span>}
                </label>
              )
            })}
          </div>
          {result.truncated && <HelperText>Stopped looking after a few seconds; there may be more.</HelperText>}
        </>
      )}
      <div className="flex items-center justify-end gap-3 pt-1">
        {secondary}
        {offered.length > 0 && (
          <PrimaryButton onClick={add} disabled={picked.size === 0}>
            {picked.size > 1 ? `Add ${picked.size} projects` : 'Add project'}
          </PrimaryButton>
        )}
      </div>
    </div>
  )
}
