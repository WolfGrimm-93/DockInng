// Validación en vivo del editor de stack (misma lógica que validate() de la plantilla). Contrato:
//   validateCompose(yaml, env) -> { list: CheckItem[], bad: Record<number,1>, hasBad: boolean, n: number }
// `list` = mensajes (ok/warn/bad); `bad` = líneas con error (para el gutter); `n` = nº de líneas.
export interface CheckItem {
  l: 'ok' | 'warn' | 'bad'
  line: number
  msg: string
}
export interface ComposeCheck {
  list: CheckItem[]
  bad: Record<number, 1>
  hasBad: boolean
  n: number
}

export function validateCompose(yaml: string, env: string): ComposeCheck {
  const out: CheckItem[] = []
  const lines = yaml.split('\n')
  const bad: Record<number, 1> = {}
  const svcs: { name: string; line: number; image: boolean }[] = []
  let inServices = false
  let cur: { name: string; line: number; image: boolean } | null = null
  lines.forEach((ln, i) => {
    if (/\t/.test(ln)) {
      out.push({ l: 'bad', line: i + 1, msg: `Línea ${i + 1}: hay tabuladores; YAML exige espacios para indentar.` })
      bad[i + 1] = 1
    }
    if (/^services:\s*$/.test(ln)) inServices = true
    else if (/^\S/.test(ln)) inServices = false
    const m = ln.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/)
    if (inServices && m) {
      cur = { name: m[1], line: i + 1, image: false }
      svcs.push(cur)
    }
    if (cur && /^ {4}(image|build):/.test(ln)) cur.image = true
  })
  if (!/^services:/m.test(yaml)) out.push({ l: 'bad', line: 0, msg: 'Falta la sección «services:».' })
  for (const s of svcs) {
    if (!s.image) {
      out.push({ l: 'bad', line: s.line, msg: `El servicio «${s.name}» necesita image o build (línea ${s.line}).` })
      bad[s.line] = 1
    }
  }
  const defined: Record<string, 1> = {}
  for (const ln of env.split('\n')) {
    const m = ln.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (m) defined[m[1]] = 1
  }
  const seen: Record<string, 1> = {}
  for (const v of yaml.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g) ?? []) {
    const k = v.slice(2)
    if (!defined[k] && !seen[k]) {
      seen[k] = 1
      out.push({ l: 'warn', line: 0, msg: `La variable ${k} no está definida en .env.` })
    }
  }
  const hasBad = out.some((o) => o.l === 'bad')
  if (!hasBad) out.unshift({ l: 'ok', line: 0, msg: `Sintaxis correcta: ${svcs.length} servicios.` })
  return { list: out, bad, hasBad, n: yaml.split('\n').length }
}
