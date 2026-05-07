import React, { useMemo } from 'react'
import { bucketByMonth, yearRangeFromHistory } from './projectStats'

interface Props { isoTimestamps: string[] }

const SPARK_CHARS = ['▁','▂','▃','▄','▅','▆','▇','█']

function monthsInRange(minYear: number, maxYear: number): string[] {
  const out: string[] = []
  for (let y = minYear; y <= maxYear; y++) {
    for (let m = 0; m < 12; m++) {
      out.push(`${y}-${String(m + 1).padStart(2, '0')}`)
    }
  }
  return out
}

export function CommitSparkline({ isoTimestamps }: Props): React.ReactElement | null {
  const counts = useMemo(() => bucketByMonth(isoTimestamps), [isoTimestamps])
  const { minYear, maxYear } = useMemo(() => yearRangeFromHistory(isoTimestamps), [isoTimestamps])
  const months = useMemo(() => monthsInRange(minYear, maxYear), [minYear, maxYear])

  if (isoTimestamps.length === 0) return null

  const values = months.map(k => counts.get(k) ?? 0)
  const max = Math.max(...values, 1)
  const spark = values.map(v => {
    if (v === 0) return SPARK_CHARS[0]
    const idx = Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * (SPARK_CHARS.length - 1)) + 1)
    return SPARK_CHARS[idx]
  }).join('')

  const yearBands: { start: number; span: number; year: number }[] = []
  for (let y = minYear; y <= maxYear; y++) {
    yearBands.push({ start: (y - minYear) * 12, span: 12, year: y })
  }

  return (
    <section className="px-4 py-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-text-subtle mb-2">Lifetime monthly</h2>
      <div className="font-mono text-[14px] leading-[1.2] tracking-[0.05em] text-emerald-400 break-all">
        {spark}
      </div>
      <div className="mt-1 flex text-[10px] text-text-subtle font-mono">
        {yearBands.map(band => (
          <div
            key={band.year}
            className="text-center border-t border-border"
            style={{ flex: `0 0 ${(band.span / months.length) * 100}%` }}
          >
            {band.year}
          </div>
        ))}
      </div>
    </section>
  )
}
