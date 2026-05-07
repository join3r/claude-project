// src/renderer/palette/parsePrefix.ts
import type { ParsedInput, Prefix } from './types'

const PRIMARY: Prefix[] = ['>', '@', '#', ':']

export function parsePrefix(input: string): ParsedInput {
  let i = 0
  let prefix: Prefix | null = null
  let allProjects = false

  if (i < input.length && (PRIMARY as string[]).includes(input[i])) {
    prefix = input[i] as Prefix
    i++
  }
  if (i < input.length && input[i] === '*') {
    allProjects = true
    i++
  }
  return { prefix, allProjects, query: input.slice(i).trimStart() }
}
