import fs from 'fs'
import path from 'path'
import type { ProjectNote } from '../shared/types'

export class NotesStorage {
  private filePath: string

  constructor(dir: string) {
    this.filePath = path.join(dir, 'notes.json')
  }

  load(): Record<string, ProjectNote[]> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  save(data: Record<string, ProjectNote[]>): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2))
  }
}
