import React from 'react'

interface Props {
  title: React.ReactNode
  onClose: () => void
  /** Tailwind width class for the card, default w-[440px] */
  width?: string
  /** Right-aligned footer content (LinkBtns + one PrimaryButton) */
  footer?: React.ReactNode
  children: React.ReactNode
}

/** Standard modal shell: dim backdrop on the modal z-rung, rounded card with pop shadow. */
export default function Modal({ title, onClose, width = 'w-[440px]', footer, children }: Props): React.ReactElement {
  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className={`${width} max-w-[90vw] max-h-[85vh] rounded-xl border border-border bg-surface shadow-pop flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 h-(--ctl-h-lg) mt-1 shrink-0">
          <h2 className="text-md font-semibold text-text m-0">{title}</h2>
          <button
            onClick={onClose}
            className="bg-transparent border-0 text-text-muted cursor-pointer text-lg leading-none px-1 rounded-sm hover:text-text"
            title="Close"
          >
            &times;
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {children}
        </div>

        {footer && (
          <footer className="flex items-center justify-end gap-3 px-4 py-3 border-t border-hair shrink-0">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
