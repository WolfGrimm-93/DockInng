// Nivel de log deducido del TEXTO (Docker no lo da): heurística, no verdad. Contrato:
//   detectLogLevel(text, stream) -> 'INFO'|'WARN'|'ERROR'|'DEBUG'
//   logLevelClass(level)         -> 'lvl-info' | ... (clases de app.css)
import type { LogStream } from '@/data/types'
import { safeText } from '@/lib/safeText'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

const RULES: [RegExp, LogLevel][] = [
  [/\b(fatal|panic|error|err|exception|failed|failure|critical)\b/i, 'ERROR'],
  [/\b(warn|warning|deprecated)\b/i, 'WARN'],
  [/\bdebug|trace\b/i, 'DEBUG'],
  [/\binfo\b/i, 'INFO'],
]

export function detectLogLevel(text: string, stream: LogStream = 'stdout'): LogLevel {
  // Un prefijo explícito ("ERROR ...", "[warn] ...") gana sobre palabras sueltas del cuerpo.
  const head = text.slice(0, 24)
  for (const [re, lvl] of RULES) if (re.test(head)) return lvl
  for (const [re, lvl] of RULES) if (re.test(text)) return lvl
  return stream === 'stderr' ? 'WARN' : 'INFO'
}

export function logLevelClass(level: LogLevel): string {
  return `lvl-${level.toLowerCase()}`
}

/** Quita un prefijo `[LEVEL] ` / `LEVEL ` explícito (y lo devuelve) para no repetirlo en la columna de nivel. */
export function splitLevelPrefix(text: string): { level: LogLevel | null; body: string } {
  const m = text.match(/^\[?(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\]?[:\s]+/i)
  if (!m) return { level: null, body: text }
  const w = m[1].toUpperCase()
  const level: LogLevel = w === 'WARNING' ? 'WARN' : w === 'TRACE' ? 'DEBUG' : (w as LogLevel)
  return { level, body: text.slice(m[0].length) }
}

// Secuencias ANSI: CSI (colores, cursor), OSC (título/hipervínculos, terminan en BEL o ST) y escapes sueltos de dos bytes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[@-Z\\-_]|\u009B[0-?]*[ -/]*[@-~]/g

/** Texto de log apto para pintar: sin secuencias ANSI, sin controles bidi ni de control (el valor original no se toca). */
export function cleanLogText(s: string): string {
  return safeText(s.replace(ANSI, ''))
}

/** Línea lista para pintar: hora local corta, nivel deducido y texto (sin prefijo de nivel). */
export function parseLogLine(line: { stream: LogStream; timestamp: string | null; message: string }): { ts: string; level: LogLevel; body: string } {
  const clean = cleanLogText(line.message)
  const { level: explicit, body } = splitLevelPrefix(clean)
  const level = explicit ?? detectLogLevel(clean, line.stream)
  let ts = ''
  if (line.timestamp) {
    const d = new Date(line.timestamp)
    if (!Number.isNaN(d.getTime())) {
      const p = (n: number, l = 2) => String(n).padStart(l, '0')
      ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
    }
  }
  return { ts, level, body }
}
