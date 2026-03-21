export function normalizeBrowserUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return 'https://www.google.com'
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  return `https://${trimmed}`
}
