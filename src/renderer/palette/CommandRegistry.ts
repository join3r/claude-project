// src/renderer/palette/CommandRegistry.ts
import type { AppCtx, Command } from './types'

export class CommandRegistry {
  private commands = new Map<string, Command>()

  register(cmd: Command): void {
    if (this.commands.has(cmd.id)) {
      throw new Error(`duplicate command id: ${cmd.id}`)
    }
    this.commands.set(cmd.id, cmd)
  }
  unregister(id: string): void {
    this.commands.delete(id)
  }
  getById(id: string): Command | undefined {
    return this.commands.get(id)
  }
  getAll(): Command[] {
    return [...this.commands.values()]
  }
  getAvailable(ctx: AppCtx): Command[] {
    return this.getAll().filter(c => !c.when || c.when(ctx))
  }
}

export const commandRegistry = new CommandRegistry()
