import fs from 'fs'
import path from 'path'

export interface FrecencyEntry { lastUsedAt: number; useCount: number }
export interface FrecencyFile {
  version: 1
  entries: Record<string, FrecencyEntry>
}

const FILENAME = 'palette-frecency.json'
const DEFAULT: FrecencyFile = { version: 1, entries: {} }

export class PaletteFrecencyStorage {
  private filePath: string
  constructor(dir: string) {
    this.filePath = path.join(dir, FILENAME)
  }
  load(): FrecencyFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as FrecencyFile
      if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object') return DEFAULT
      return parsed
    } catch {
      return DEFAULT
    }
  }
  save(file: FrecencyFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8')
  }
}
