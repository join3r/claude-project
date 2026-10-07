import React, { useEffect } from 'react'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { menuCls, menuItemCls } from './menu'
import { formatShortcutForApp } from '../../../shared/shortcut-label'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** An accelerator (`CmdOrCtrl+T`), shown on the right as this platform writes it. */
  shortcut?: string
  /** A rule above this item, starting a new group. */
  dividerBefore?: boolean
}

/**
 * A right-click menu at the pointer, kept inside the window. Any click outside,
 * another right-click or Escape closes it; picking an item closes it first.
 */
export default function ContextMenu({ menu, items, onClose }: {
  menu: MenuAnchor | null
  items: ContextMenuItem[]
  onClose: () => void
}): React.ReactElement | null {
  const position = useMenuPosition<HTMLDivElement>(menu)

  useEffect(() => {
    if (!menu) return
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menu, onClose])

  if (!menu) return null
  return (
    <>
      <div
        className="fixed inset-0 z-(--z-menu)"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div ref={position.ref} role="menu" className={`fixed z-(--z-menu) ${menuCls}`} style={position.style}>
        {items.map((item) => (
          <React.Fragment key={item.label}>
            {item.dividerBefore && <div role="separator" className="border-t border-hair my-1" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`${menuItemCls}${item.danger ? ' text-danger' : ''}${item.shortcut ? ' flex items-center gap-6' : ''} disabled:opacity-50 disabled:cursor-default`}
              onClick={() => {
                onClose()
                item.onSelect()
              }}
            >
              {item.shortcut ? (
                <>
                  <span className="flex-1">{item.label}</span>
                  <span className="text-xs text-text-subtle">{formatShortcutForApp(item.shortcut)}</span>
                </>
              ) : item.label}
            </button>
          </React.Fragment>
        ))}
      </div>
    </>
  )
}
