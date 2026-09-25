// <SafeName>: nombre no confiable saneado (safeText) y aislado con <bdi> (la dirección del texto no contamina lo de alrededor).
// Contrato: <SafeName ellipsis? className? mono?>{value}</SafeName>
//   - por defecto `overflow-wrap:anywhere` (nombres de miles de caracteres no desbordan); `ellipsis` = una línea con «…».
//   - `title` = texto saneado completo (el valor exacto sigue accesible).
import type { CSSProperties } from 'react'
import { safeText } from '@/lib/safeText'

export function SafeName({ children, ellipsis, className, mono }: { children: unknown; ellipsis?: boolean; className?: string; mono?: boolean }) {
  const t = safeText(children, { singleLine: true })
  const style: CSSProperties = ellipsis
    ? { display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }
    : { overflowWrap: 'anywhere' }
  return <bdi className={`${mono ? 'mono ' : ''}${className ?? ''}`.trim() || undefined} style={style} title={t}>{t}</bdi>
}
