// Coloreado de JSON SIN HTML: devuelve tokens que la vista pinta como nodos <span> (React escapa el texto).
// Los valores de `docker inspect` son datos no confiables (env, labels): nunca se inyectan como HTML.
//   tokenizeJson(value) -> JsonToken[]  (kind: 'k' clave · 's' cadena · 'n' número · 'b' bool/null · 'p' puntuación)
export interface JsonToken {
  kind: 'k' | 's' | 'n' | 'b' | 'p'
  text: string
}

const RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g

export function tokenizeJson(value: unknown, space = 2): JsonToken[] {
  const src = JSON.stringify(value, null, space) ?? 'null'
  const out: JsonToken[] = []
  let last = 0
  for (const m of src.matchAll(RE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'p', text: src.slice(last, at) })
    if (m[1] !== undefined) {
      if (m[2]) {
        out.push({ kind: 'k', text: m[1] }, { kind: 'p', text: m[2] })
      } else out.push({ kind: 's', text: m[1] })
    } else if (m[3] !== undefined) out.push({ kind: 'b', text: m[0] })
    else out.push({ kind: 'n', text: m[0] })
    last = at + m[0].length
  }
  if (last < src.length) out.push({ kind: 'p', text: src.slice(last) })
  return out
}
