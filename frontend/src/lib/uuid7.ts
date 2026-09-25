// UUID v7 (RFC 9562) sin dependencias. Regla del proyecto: todo ID generado en cliente es v7.
// Contrato: `uuidv7(now?: number): string` — 48 bits de milisegundos Unix + versión 7 + variante 10 + 74 bits aleatorios.

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // 48 bits de marca de tiempo (ms), big-endian. No se usan operadores de bits sobre `now` (supera 32 bits).
  let ts = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256
    ts = Math.floor(ts / 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70 // versión 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variante RFC 4122/9562
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
