import React, { useMemo, useState } from 'react'
import { bucketByDay, quartileBins, yearRangeFromHistory } from './projectStats'

interface Props {
  isoTimestamps: string[]
}

const CELL_BG = ['bg-surface-2', 'bg-emerald-900', 'bg-emerald-700', 'bg-emerald-500', 'bg-emerald-300']
const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function startOfYearMonday(year: number): Date {
  const jan1 = new Date(year, 0, 1)
  const dayIdx = (jan1.getDay() + 6) % 7
  const start = new Date(year, 0, 1 - dayIdx)
  start.setHours(0, 0, 0, 0)
  return start
}

function buildGrid(year: number): { iso: string; date: Date; inYear: boolean }[][] {
  const start = startOfYearMonday(year)
  const cols: { iso: string; date: Date; inYear: boolean }[][] = []
  for (let week = 0; week < 53; week++) {
    const col: { iso: string; date: Date; inYear: boolean }[] = []
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(start)
      date.setDate(start.getDate() + week * 7 + dow)
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      col.push({ iso, date, inYear: date.getFullYear() === year })
    }
    cols.push(col)
  }
  return cols
}

export function CommitHeatmap({ isoTimestamps }: Props): React.ReactElement {
  const dayCounts = useMemo(() => bucketByDay(isoTimestamps), [isoTimestamps])
  const { minYear, maxYear } = useMemo(() => yearRangeFromHistory(isoTimestamps), [isoTimestamps])
  const [year, setYear] = useState<number>(maxYear)

  const grid = useMemo(() => buildGrid(year), [year])
  const yearCounts = useMemo(() => {
    const all: number[] = []
    for (const col of grid) for (const cell of col) {
      if (!cell.inYear) continue
      const c = dayCounts.get(cell.iso) ?? 0
      if (c > 0) all.push(c)
    }
    return all
  }, [grid, dayCounts])
  const bin = useMemo(() => quartileBins(yearCounts), [yearCounts])

  const monthHeader = useMemo(() => {
    const labels: { col: number; text: string }[] = []
    let lastMonth = -1
    grid.forEach((col, i) => {
      const firstInYearCell = col.find(c => c.inYear)
      if (!firstInYearCell) return
      const m = firstInYearCell.date.getMonth()
      if (m !== lastMonth) {
        labels.push({ col: i, text: MONTH_LABELS[m] })
        lastMonth = m
      }
    })
    return labels
  }, [grid])

  const canPrev = year > minYear
  const canNext = year < maxYear

  return (
    <section className="px-4 py-3">
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-text-subtle">Commits</h2>
        <div className="flex items-center gap-2 text-xs text-text-subtle">
          <button
            type="button"
            onClick={() => canPrev && setYear(y => y - 1)}
            disabled={!canPrev}
            className="bg-transparent border-0 cursor-pointer text-text-subtle hover:text-text disabled:opacity-30 disabled:cursor-default"
            aria-label="Previous year"
          >&lsaquo;</button>
          <span className="font-mono text-text">{year}</span>
          <button
            type="button"
            onClick={() => canNext && setYear(y => y + 1)}
            disabled={!canNext}
            className="bg-transparent border-0 cursor-pointer text-text-subtle hover:text-text disabled:opacity-30 disabled:cursor-default"
            aria-label="Next year"
          >&rsaquo;</button>
        </div>
      </header>
      <div className="overflow-x-auto">
        <div className="inline-block">
          <div className="grid grid-cols-[auto_1fr] gap-x-2">
            <div />
            <div className="grid grid-flow-col auto-cols-[12px] gap-[2px] mb-1 text-[10px] text-text-subtle">
              {Array.from({ length: 53 }, (_, i) => {
                const lbl = monthHeader.find(l => l.col === i)
                return <div key={i} className="h-3">{lbl?.text ?? ''}</div>
              })}
            </div>
            <div className="grid grid-rows-7 grid-flow-row auto-rows-[12px] gap-[2px] text-[10px] text-text-subtle pr-1">
              {WEEKDAY_LABELS.map((d, i) => <div key={i} className="leading-3">{i % 2 === 0 ? d : ''}</div>)}
            </div>
            <div className="grid grid-flow-col auto-cols-[12px] grid-rows-7 gap-[2px]">
              {grid.flatMap((col, ci) => col.map((cell, ri) => {
                const count = dayCounts.get(cell.iso) ?? 0
                const level = cell.inYear ? bin(count) : 0
                const monthName = MONTH_LABELS[cell.date.getMonth()]
                return (
                  <div
                    key={`${ci}-${ri}`}
                    className={`h-3 w-3 rounded-[2px] ${cell.inYear ? CELL_BG[level] : 'bg-transparent'}`}
                    title={cell.inYear ? `${monthName} ${cell.date.getDate()}, ${cell.date.getFullYear()} · ${count} commit${count === 1 ? '' : 's'}` : undefined}
                  />
                )
              }))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 mt-2 text-[10px] text-text-subtle">
          <span>Less</span>
          {CELL_BG.map((cls, i) => <div key={i} className={`h-3 w-3 rounded-[2px] ${cls}`} />)}
          <span>More</span>
        </div>
      </div>
    </section>
  )
}
