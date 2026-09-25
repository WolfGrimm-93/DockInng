// SearchField: campo de búsqueda con icono (.field .field-search). Contrato: <SearchField id placeholder value onChange />
import { Icon } from './Icon'

export function SearchField({ id, placeholder, value, onChange }: { id: string; placeholder: string; value: string; onChange(v: string): void }) {
  return (
    <label className="field field-search">
      <Icon name="search" />
      <input className="input" id={id} type="search" placeholder={placeholder} aria-label={placeholder} value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
