// Grupo de opciones EXCLUYENTES accesible: role="radiogroup" + role="radio" (aria-checked), tabindex móvil (roving),
// flechas/Inicio/Fin mueven la selección (como un radio nativo) y foco visible. Contrato:
//   <ChoiceGroup label value onChange options={[{value,label,title?,children?}]} variant="swatch"|"segmented"|"chip"|"combo" />
import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

export interface Choice<T extends string> { value: T; label: string; children?: ReactNode; disabled?: boolean; style?: CSSProperties; className?: string }

export function ChoiceGroup<T extends string>({ label, value, options, onChange, variant = 'chip', className }: {
  label: string
  value: T | null
  options: Choice<T>[]
  onChange(v: T): void
  variant?: 'swatch' | 'segmented' | 'chip' | 'combo'
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.filter((o) => !o.disabled)
  const onKey = (e: KeyboardEvent, i: number) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    let next = -1
    const at = enabled.findIndex((o) => o === options[i])
    if (e.key in keys) next = (at + keys[e.key] + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0) return
    e.preventDefault()
    const target = enabled[next]
    onChange(target.value)
    refs.current[options.indexOf(target)]?.focus()
  }
  const tabbable = value !== null && options.some((o) => o.value === value && !o.disabled) ? value : (enabled[0]?.value ?? null)
  return (
    <div role="radiogroup" aria-label={label} className={`choice choice-${variant}${variant === 'segmented' ? ' segmented' : ''} ${className ?? ''}`}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.children ? o.label : undefined}
          tabIndex={o.value === tabbable ? 0 : -1}
          disabled={o.disabled}
          style={o.style}
          className={o.className}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.children ?? o.label}
        </button>
      ))}
    </div>
  )
}
