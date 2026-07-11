import type { Tab, TabType } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'

const ATTENTION_RE = /\b(error|failed|fail)\b/i
const READY_RE = /\b(ready|listening|served|compiled successfully)\b/i

export function terminalStatusFromOutput(
  line: string,
  prev: TabStatusValue
): TabStatusValue {
  if (ATTENTION_RE.test(line)) return 'attention'
  if (READY_RE.test(line)) return null
  if (prev === 'attention') return 'attention'
  return 'working'
}

export const PINNABLE_TAB_TYPES: ReadonlySet<TabType> = new Set<TabType>([
  'terminal',
  'claude',
  'codex',
  'pi'
])

export function isPinnable(tab: Tab): boolean {
  return PINNABLE_TAB_TYPES.has(tab.type)
}
