// Lista de elementos afectados dentro de un diálogo (.dlg-list). Contrato: <DialogList label items={[{icon?,text,end?,mono?}]} />
// `text`/`end` son TEXTO (React escapa): nunca HTML. Nombres largos: title con el valor completo.
import { Icon } from './Icon'
import { SafeName } from './SafeName'
import type { IconName } from './iconNames'

export interface DialogListItem { key?: string; icon?: IconName; text: string; end?: string }

export function DialogList({ label, items }: { label: string; items: DialogListItem[] }) {
  return (
    <ul className="dlg-list" aria-label={label}>
      {items.map((it, i) => (
        <li key={it.key ?? `${it.text}-${i}`}>
          {it.icon ? <Icon name={it.icon} size="sm" /> : null}
          <SafeName mono ellipsis>{it.text}</SafeName>
          {it.end ? <span className="end"><SafeName>{it.end}</SafeName></span> : null}
        </li>
      ))}
    </ul>
  )
}
