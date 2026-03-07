import fs from 'fs'
import path from 'path'

export class ScrollbackStorage {
  private dir: string

  constructor(dir: string) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.dir = dir
  }

  private filePath(tabId: string): string {
    return path.join(this.dir, `${tabId}.txt`)
  }

  save(tabId: string, data: string): void {
    fs.writeFileSync(this.filePath(tabId), data)
  }

  load(tabId: string): string | null {
    try {
      return fs.readFileSync(this.filePath(tabId), 'utf-8')
    } catch {
      return null
    }
  }

  delete(tabId: string): void {
    try {
      fs.unlinkSync(this.filePath(tabId))
    } catch {
      // File doesn't exist, no-op
    }
  }
}
