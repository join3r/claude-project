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
