// Segmented<T>: filtros segmentados (.segmented) con botones aria-pressed. NO usa ToggleGroup de Base UI
// (permite des-seleccionar); siempre hay una opción activa. Contrato:
//   <Segmented value onChange ariaLabel options={[{value,label,count?,icon?}]} className? style? />
import type { CSSProperties, ReactNode } from 'react'

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; count?: number }

export function Segmented<T extends string>({ value, options, onChange, ariaLabel, labelledBy, className, style }: {
  value: T
  options: SegmentedOption<T>[]
  onChange(v: T): void
  ariaLabel?: string
  labelledBy?: string
  className?: string
  style?: CSSProperties
}) {
  return (
    <div role="group" aria-label={ariaLabel} aria-labelledby={labelledBy} className={className ? `segmented ${className}` : 'segmented'} style={style}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count != null ? <span className="muted"> {o.count}</span> : null}
        </button>
      ))}
    </div>
  )
}
