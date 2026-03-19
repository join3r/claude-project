export type PaneSide = 'left' | 'right'

export function getPaneFromValue(value: string | null | undefined): PaneSide | null {
  if (value === 'left' || value === 'right') return value
  return null
}

export function resolvePaneForMenuAction(splitOpen: boolean, activePane: PaneSide | null, fallbackPane: PaneSide | null): PaneSide {
  if (activePane) return activePane
  if (splitOpen && fallbackPane) return fallbackPane
  return 'left'
}
