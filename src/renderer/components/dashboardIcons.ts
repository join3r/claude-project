// Helpers for https://dashboardicons.com (homarr-labs/dashboard-icons on GitHub).
// Icons are served from jsDelivr; metadata.json describes available slugs,
// per-slug base format (svg|png), and optional light/dark variants.

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons'
const METADATA_URL = `${CDN_BASE}/metadata.json`

export interface DashboardIconEntry {
  base: 'svg' | 'png'
  aliases?: string[]
  categories?: string[]
  colors?: { light?: string; dark?: string }
}

export type DashboardIconsMetadata = Record<string, DashboardIconEntry>

let metadataPromise: Promise<DashboardIconsMetadata> | null = null

export function fetchDashboardIconsMetadata(): Promise<DashboardIconsMetadata> {
  if (!metadataPromise) {
    metadataPromise = fetch(METADATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`metadata.json HTTP ${res.status}`)
        return res.json() as Promise<DashboardIconsMetadata>
      })
      .catch((err) => {
        // Reset so a later open can retry after a transient failure.
        metadataPromise = null
        throw err
      })
  }
  return metadataPromise
}

export interface IconUrlOptions {
  theme?: 'light' | 'dark'
  metadata?: DashboardIconsMetadata
}

// Accepts either a slug (e.g. "vscode") or a full URL (e.g. pasted from
// dashboardicons.com). Picks the theme-appropriate variant when metadata is
// available and the icon defines colors.light / colors.dark.
export function dashboardIconUrl(value: string, opts: IconUrlOptions = {}): string | null {
  const v = value.trim()
  if (!v) return null
  if (/^https?:\/\//i.test(v)) return v

  const slug = v.toLowerCase().replace(/\.(svg|png|webp)$/i, '')
  const entry = opts.metadata?.[slug]
  const base = entry?.base ?? 'svg'

  let finalSlug = slug
  if (entry?.colors && opts.theme) {
    const variant = entry.colors[opts.theme]
    if (variant) finalSlug = variant
  }

  return `${CDN_BASE}/${base}/${finalSlug}.${base}`
}

export interface IconSearchHit {
  slug: string
  matchedAlias?: string
}

export function searchDashboardIcons(
  metadata: DashboardIconsMetadata,
  query: string,
  limit = 12,
): IconSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const starts: IconSearchHit[] = []
  const contains: IconSearchHit[] = []
  for (const [slug, entry] of Object.entries(metadata)) {
    if (slug.startsWith(q)) {
      starts.push({ slug })
    } else if (slug.includes(q)) {
      contains.push({ slug })
    } else {
      const alias = entry.aliases?.find((a) => a.toLowerCase().includes(q))
      if (alias) contains.push({ slug, matchedAlias: alias })
    }
    if (starts.length >= limit) break
  }
  return [...starts, ...contains].slice(0, limit)
}
