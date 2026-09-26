// Detección de orígenes de montaje sensibles al crear un contenedor (aviso NO bloqueante; el backend re-evalúa y decide si exige confirmar).
// Contrato: sensitiveBind(source, readOnly) -> { level: 'danger'|'warn', text } | null
export interface BindWarning { level: 'danger' | 'warn'; text: string }

/** Normaliza `//`, `/./` y `/..`; devuelve null si no es una ruta absoluta o `~`. */
export function normalizePath(p: string): string | null {
  const t = p.trim()
  if (!t) return null
  if (t !== '~' && !t.startsWith('~/') && !t.startsWith('/')) return null
  const parts: string[] = []
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  const joined = parts.join('/')
  return t.startsWith('~') ? joined : '/' + joined
}

const EXACT: Record<string, string> = {
  '/': 'la raíz del equipo', '/etc': '/etc (configuración del sistema)', '/root': '/root', '/home': '/home (todos los usuarios)', '/boot': '/boot',
  '/proc': '/proc', '/sys': '/sys', '/dev': '/dev', '/run': '/run', '/var/run': '/var/run', '/var/lib/docker': '/var/lib/docker', '~': 'tu carpeta personal completa',
}
const SECRET_DIRS = ['~/.ssh', '~/.gnupg', '~/.aws', '~/.kube']

export function sensitiveBind(source: string, readOnly = false): BindWarning | null {
  const n = normalizePath(source)
  if (n === null) return null
  if (/(^|\/)docker\.sock$/.test(n)) return { level: 'danger', text: `${n} da control total de Docker al contenedor: equivale a acceso de administrador al equipo.` }
  if (n in EXACT) return { level: 'danger', text: `Ruta sensible: da acceso a ${EXACT[n]}.${readOnly ? '' : ' Con escritura, el contenedor puede modificarla.'}` }
  for (const d of SECRET_DIRS) if (n === d || n.startsWith(d + '/')) return { level: 'danger', text: `Ruta sensible: ${d} contiene credenciales.` }
  if (!readOnly && (n.startsWith('/etc/') || n.startsWith('/usr') || n.startsWith('/boot/') || n.startsWith('/root/'))) return { level: 'warn', text: `Se permite escribir en ${n}, una ruta del sistema.` }
  return null
}
