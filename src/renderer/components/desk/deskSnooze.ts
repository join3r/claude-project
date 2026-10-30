/** The desk's snooze menu, in the board's order: Tomorrow · This evening · Next week · Until it needs me · Pick a date…. */

export interface DeskSnoozeChoice {
  id: 'tomorrow' | 'evening' | 'monday' | 'attention'
  label: string
  /** Absolute wake time; absent for "until it needs me". */
  until?: number
  untilAttention?: boolean
  hint: string
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function atHour(now: number, dayOffset: number, hour: number): number {
  const date = new Date(now)
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

/** "Fri 9:00", "18:00". */
export function wakeHint(at: number, withDay: boolean): string {
  const date = new Date(at)
  const clock = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  return withDay ? `${DAYS[date.getDay()]} ${clock}` : clock
}

export function deskSnoozeChoices(now: number): DeskSnoozeChoice[] {
  const choices: DeskSnoozeChoice[] = []
  const tomorrow = atHour(now, 1, 9)
  choices.push({ id: 'tomorrow', label: 'Tomorrow', until: tomorrow, hint: wakeHint(tomorrow, true) })
  const evening = atHour(now, 0, 18)
  if (evening > now) choices.push({ id: 'evening', label: 'This evening', until: evening, hint: wakeHint(evening, false) })
  // Next Monday; on a Monday that is a week out, not today.
  const daysToMonday = ((8 - new Date(now).getDay()) % 7) || 7
  const monday = atHour(now, daysToMonday, 9)
  choices.push({ id: 'monday', label: 'Next week', until: monday, hint: wakeHint(monday, true) })
  choices.push({ id: 'attention', label: 'Until it needs me', untilAttention: true, hint: 'agent wakes it' })
  return choices
}

/** A `datetime-local` value for `at`, local time. */
export function toLocalInputValue(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
