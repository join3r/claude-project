export function bucketByDay(isoTimestamps: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const iso of isoTimestamps) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  return m
}

export function bucketByMonth(isoTimestamps: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const iso of isoTimestamps) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  return m
}

export function quartileBins(nonZeroCounts: number[]): (count: number) => 0 | 1 | 2 | 3 | 4 {
  if (nonZeroCounts.length === 0) return () => 0
  const sorted = [...nonZeroCounts].sort((a, b) => a - b)
  return (count: number) => {
    if (count <= 0) return 0
    let rank = 0
    for (const v of sorted) if (v <= count) rank++
    const pct = rank / sorted.length
    if (pct <= 0.25) return 1
    if (pct <= 0.5) return 2
    if (pct <= 0.75) return 3
    return 4
  }
}

export function yearRangeFromHistory(isoTimestamps: string[]): { minYear: number; maxYear: number } {
  if (isoTimestamps.length === 0) {
    const y = new Date().getFullYear()
    return { minYear: y, maxYear: y }
  }
  let minYear = Infinity
  let maxYear = -Infinity
  for (const iso of isoTimestamps) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    const y = d.getFullYear()
    if (y < minYear) minYear = y
    if (y > maxYear) maxYear = y
  }
  if (!Number.isFinite(minYear) || !Number.isFinite(maxYear)) {
    const y = new Date().getFullYear()
    return { minYear: y, maxYear: y }
  }
  return { minYear, maxYear }
}

export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const diff = nowMs - timestampMs
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
