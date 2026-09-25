import type { CSSProperties } from 'react'

/** Matiz (OKLCH) de un grupo como variable CSS: `oklch(var(--grp-l) var(--grp-c) var(--grp-h))` (L/C fijos por tema en app.css). */
export const hueStyle = (h: number): CSSProperties => ({ ['--grp-h' as string]: h })
