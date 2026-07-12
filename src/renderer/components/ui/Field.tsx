import React from 'react'

const fieldCls =
  'h-(--ctl-h) px-2.5 rounded-md bg-field border border-border text-base text-text ' +
  'focus:border-border-focus focus:shadow-focus outline-none disabled:opacity-50 ' +
  'placeholder:text-text-subtle'

type InputProps = React.InputHTMLAttributes<HTMLInputElement>

/** Standard text/number input — compact control height on the field surface. */
export function Field({ className, ...rest }: InputProps): React.ReactElement {
  return <input className={`${fieldCls} ${className ?? ''}`} {...rest} />
}

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>

/** Standard dropdown, same geometry as Field. */
export function Select({ className, children, ...rest }: SelectProps): React.ReactElement {
  return (
    <select className={`${fieldCls} cursor-pointer ${className ?? ''}`} {...rest}>
      {children}
    </select>
  )
}
