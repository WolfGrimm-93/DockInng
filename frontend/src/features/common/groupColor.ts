// Color de cada stack (agrupación) en la tabla de contenedores. Solo es decorativo (barra, punto y tinte de la cabecera):
// el nombre del stack siempre va en texto, así que el color nunca es el único portador de información.
// Los 8 matices (OKLCH) se eligen para que L/C fijos (claro 0.55/0.13, oscuro 0.74/0.12) den ≥ 3:1 sobre las
// superficies del tema (medido: mínimo 4.05 en claro y 6.62 en oscuro).

export const GROUP_HUES = [175, 205, 240, 270, 300, 335, 55, 90] as const

/** Hash FNV-1a de 32 bits: estable entre sesiones para el mismo nombre. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Asigna un matiz a cada nombre de stack. Cada nombre prefiere el matiz que le da su hash; si ya está ocupado por otro,
 * toma el siguiente libre (se recorren los nombres en orden alfabético para que el resultado no dependa del orden de la lista).
 * Con más de 8 stacks los matices se reutilizan.
 */
export function assignGroupHues(names: Iterable<string>): Map<string, number> {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b))
  const used = new Set<number>()
  const out = new Map<string, number>()
  for (const name of sorted) {
    let slot = fnv1a(name) % GROUP_HUES.length
    if (used.size < GROUP_HUES.length) while (used.has(slot)) slot = (slot + 1) % GROUP_HUES.length
    used.add(slot)
    out.set(name, GROUP_HUES[slot])
  }
  return out
}
