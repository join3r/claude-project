import { AI_TAB_META, AI_TAB_TYPES, type AiTabType } from './types'

/**
 * The agent CLIs a host has (plan step 7, "Agent CLIs"): what `host-agent-clis`
 * answers, and how DevTool installs a missing one on a DevTool server. The
 * detection runs on the host, on its login PATH; the install runs the agent's
 * official installer in a visible terminal tab there.
 */

export interface AgentCliStatus {
  /** On the host's login PATH (or at the path its settings name). */
  found: boolean
  /** Where it was found. */
  path?: string
  /** What `<cli> --version` said, when it answered in time. */
  version?: string
}

export interface AgentClisReport {
  clis: Record<AiTabType, AgentCliStatus>
  /** The host's `process.platform`. */
  platform: string
  /** Epoch ms. */
  checkedAt: number
}

export interface AgentInstaller {
  /** The command the agent's own docs give, run as it is. */
  command: string
  /** Where those docs are. */
  docs: string
}

/**
 * The official installers. None needs Node or npm: Claude Code's and Codex's
 * download a native binary into `~/.local/bin`, Pi's offers to install Node
 * itself when it is missing. Codex's is the command `codex` runs to update
 * itself, which skips its questions; the others may ask, in the terminal.
 */
export const AGENT_INSTALLERS: Readonly<Record<AiTabType, AgentInstaller>> = {
  claude: { command: 'curl -fsSL https://claude.ai/install.sh | bash', docs: 'https://code.claude.com/docs/en/setup' },
  codex: { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh', docs: 'https://github.com/openai/codex' },
  pi: { command: 'curl -fsSL https://pi.dev/install.sh | sh', docs: 'https://pi.dev' }
}

/** The CLI an agent tab type runs. */
export function agentCliCommand(agent: AiTabType): string {
  return AI_TAB_META[agent].command
}

/** A report saying nothing is installed (a host that couldn't be asked counts as unknown, not this). */
export function emptyAgentClisReport(platform: string, checkedAt: number): AgentClisReport {
  const clis = Object.fromEntries(AI_TAB_TYPES.map(agent => [agent, { found: false }])) as Record<AiTabType, AgentCliStatus>
  return { clis, platform, checkedAt }
}

/** `2.1.295` from `2.1.295 (Claude Code)`, `codex-cli 0.158.0` or `v0.80.10`; null when there is none. */
export function versionFrom(output: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(output)
  return match ? match[0] : null
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * What an install tab runs with `/bin/sh -c`: the installer's command echoed and
 * run as the docs give it (under bash with pipefail, so a failed download is a
 * failure rather than an empty script that "succeeds"), then a line saying how
 * it went. The PTY exits with the installer's status.
 */
export function agentInstallScript(agent: AiTabType): string {
  return installScript(AGENT_INSTALLERS[agent].command, AI_TAB_META[agent].label)
}

/** {@link agentInstallScript} for any command (tests run it with a stand-in). */
export function installScript(command: string, label: string): string {
  return [
    `cmd=${shQuote(command)}`,
    `printf '\\033[2m$ %s\\033[0m\\n\\n' "$cmd"`,
    'if command -v bash >/dev/null 2>&1; then bash -o pipefail -c "$cmd"; else sh -c "$cmd"; fi',
    'status=$?',
    `if [ "$status" -eq 0 ]; then printf '\\n\\033[32m%s\\033[0m\\n' ${shQuote(`${label} installer finished. DevTool checks the server again.`)}; ` +
      `else printf '\\n\\033[31m%s %s.\\033[0m\\n' ${shQuote(`${label} installer failed with exit code`)} "$status"; fi`,
    'exit "$status"'
  ].join('\n')
}
