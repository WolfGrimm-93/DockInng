// Diagnóstico de conexión en español a partir de ConnectionStatus (backend: PLAN §1.9 — los textos y
// comandos sugeridos viven en el frontend, indexados por causa/paso). Contrato:
//   buildDiagnostic(failed, profile) -> Diagnostic        (paneles «permiso», «daemon», «ssh» de la plantilla)
//   issueOf(failed, profile)         -> 'permission'|'daemon'|'ssh'
//   pendingDiagnostic / DIAG_TAGS    etiquetas de los pasos
import type { ConnectionCause, ConnectionProfile, ConnectionStatus, DiagStep, DiagStepId, Diagnostic } from './types'

type Failed = Extract<ConnectionStatus, { state: 'failed' }>

export function issueOf(f: Failed, profile: ConnectionProfile): Diagnostic['issue'] {
  if (profile.kind !== 'local') return 'ssh'
  return f.cause === 'permission_denied' ? 'permission' : 'daemon'
}

function socketPath(endpoint: string): string {
  return endpoint.replace(/^unix:\/\//, '') || '/var/run/docker.sock'
}

const TAG = { ok: 'Correcto', fail: 'Falla', skip: 'Pendiente' } as const

function localSteps(f: Failed): DiagStep[] {
  const sock = socketPath(f.endpoint)
  const by = (id: DiagStepId) => f.steps.find((s) => s.id === id)
  const st = (id: DiagStepId): 'ok' | 'fail' | 'skip' => {
    const s = by(id)
    return !s ? 'skip' : s.status === 'skipped' ? 'skip' : s.status
  }
  const socket = st('socket')
  const perms = st('permissions')
  const daemon = st('daemon')
  return [
    {
      state: socket,
      title: 'Socket',
      detail:
        socket === 'ok'
          ? `El archivo ${sock} existe.`
          : socket === 'fail'
            ? `No hay nadie escuchando en ${sock} (${by('socket')?.detail || 'connection refused'}).`
            : 'Sin comprobar.',
      tag: TAG[socket],
    },
    {
      state: perms,
      title: 'Permisos y grupo docker',
      detail:
        perms === 'ok'
          ? 'Tu usuario puede abrir el socket.'
          : perms === 'fail'
            ? 'Tu usuario no pertenece al grupo docker, por eso el socket rechaza la conexión (permission denied).'
            : 'Sin comprobar: primero tiene que arrancar el motor.',
      command: perms === 'fail' ? 'sudo usermod -aG docker $USER' : perms === 'skip' ? 'id -nG | tr " " "\\n" | grep docker' : undefined,
      hint: perms === 'fail' ? 'Cierra sesión y vuelve a entrar para que el cambio surta efecto.' : undefined,
      tag: TAG[perms],
    },
    {
      state: daemon,
      title: 'Daemon',
      detail:
        daemon === 'ok'
          ? 'El daemon de Docker responde.'
          : daemon === 'fail'
            ? 'El servicio docker está inactivo.'
            : 'Sin comprobar: depende del paso anterior. Para verlo tú mismo:',
      command: daemon === 'fail' ? 'sudo systemctl start docker' : daemon === 'skip' ? 'systemctl is-active docker' : undefined,
      hint: daemon === 'fail' ? 'Para que arranque con el equipo: sudo systemctl enable docker' : undefined,
      tag: TAG[daemon],
    },
  ]
}

/** Entrecomilla para un shell POSIX solo si hace falta (nombres visibles o hosts nunca se interpolan crudos en un comando sugerido). */
export function shq(s: string): string {
  return /^[A-Za-z0-9._@:/=+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** `ssh [-p N] [user@]host <resto>` derivado del DESTINO real de la conexión (no del nombre visible). */
export function sshCommand(target: string, rest: string): string {
  const m = /^ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?/.exec(target)
  if (!m) return `ssh ${shq(target)} ${rest}`
  const [, user, host, port] = m
  return `ssh${port ? ` -p ${port}` : ''} ${shq(`${user ? `${user}@` : ''}${host}`)} ${rest}`
}

function hostOf(target: string): string {
  const m = target.match(/@([^:/]+)/) ?? target.match(/^[a-z]+:\/\/([^:/]+)/)
  return m ? m[1] : target
}

const CAUSE_TEXT: Partial<Record<ConnectionCause, string>> = {
  host_key_unknown: 'La clave del host todavía no está confirmada: verifica su huella antes de conectar.',
  host_key_changed: 'La clave del host CAMBIÓ respecto a la que habías confiado. No se conecta: podría ser una suplantación.',
  auth_failed: 'El servidor rechazó la autenticación (llave o certificado).',
  unreachable: 'No se pudo alcanzar el host (red, puerto o cortafuegos).',
  remote_docker_missing: 'Docker no está disponible en el host remoto (o no está en el PATH del usuario).',
  tls_invalid: 'El certificado no es válido o no coincide con la CA indicada.',
  permission_denied: 'Tu usuario no puede usar el socket de Docker.',
  daemon_down: 'El servicio de Docker no responde.',
  socket_missing: 'No existe el socket de Docker.',
}
/** Frase corta en español para un toast de fallo al cambiar de conexión (la causa clasificada gana al mensaje crudo). */
export function connectionFailText(cause: ConnectionCause | null | undefined, message: string): string {
  const t = cause ? CAUSE_TEXT[cause] : undefined
  return t ? (message ? `${t} (${message})` : t) : message
}

/** Pasos del diagnóstico de una conexión remota según la causa clasificada por el backend. */
function remoteSteps(f: Failed, profile: ConnectionProfile): DiagStep[] {
  const host = hostOf(profile.target)
  const tls = profile.kind === 'tls'
  const c = f.cause
  const step = (state: DiagStep['state'], title: string, detail: string, extra: Partial<DiagStep> = {}): DiagStep => ({ state, title, detail, tag: TAG[state], ...extra })
  const skipNet = c === 'unreachable' ? 'fail' : 'ok'
  const net = step(skipNet, 'Red', c === 'unreachable' ? `No se llegó a ${host}: ${f.message || 'tiempo de espera agotado'}.` : `El host ${host} responde en el puerto ${/:(\d+)$/.exec(profile.target)?.[1] ?? '22'}.`,
    c === 'unreachable' ? { command: `ping -c1 ${host}`, hint: 'Comprueba el puerto, la VPN y el cortafuegos.' } : {})
  if (tls) {
    return [
      net,
      step(c === 'tls_invalid' ? 'fail' : c === 'unreachable' ? 'skip' : c === 'auth_failed' ? 'fail' : 'ok', 'Certificados TLS',
        c === 'tls_invalid' ? `El certificado del servidor no es de confianza para la CA indicada. ${f.message}` : c === 'auth_failed' ? 'El servidor rechazó el certificado de cliente.' : 'Certificados aceptados.',
        c === 'tls_invalid' ? { hint: 'Revisa las rutas de la CA, el certificado y la llave en la conexión (Configuración).' } : {}),
      step('skip', 'Socket remoto', 'Sin comprobar: hace falta la conexión TLS.'),
    ]
  }
  // Causa no clasificada (backend antiguo / error genérico): panel clásico de 3 pasos.
  if (!c || c === 'other') {
    return [
      net,
      step('fail', 'Autenticación SSH', 'El servidor rechazó la llave (Permission denied, publickey). Revisa el alias en ~/.ssh/config.', { command: sshCommand(profile.target, 'docker info'), hint: 'Si funciona en la terminal, comprueba que la llave esté cargada con ssh-add.' }),
      step('skip', 'Socket remoto', 'Sin comprobar: hace falta autenticarse antes.'),
    ]
  }
  const keyState: DiagStep['state'] = c === 'host_key_unknown' || c === 'host_key_changed' ? 'fail' : c === 'unreachable' ? 'skip' : 'ok'
  // permission_denied / daemon_down llegan también de remotos (el socket del host remoto): la autenticación SSH ya pasó y falla «Docker remoto».
  const dockerFails = c === 'remote_docker_missing' || c === 'permission_denied' || c === 'daemon_down' || c === 'socket_missing'
  const authState: DiagStep['state'] = c === 'auth_failed' ? 'fail' : dockerFails ? 'ok' : 'skip'
  const dockerState: DiagStep['state'] = dockerFails ? 'fail' : 'skip'
  const dockerText = c === 'permission_denied' ? 'El usuario remoto no puede usar el socket de Docker (no está en el grupo docker).'
    : c === 'daemon_down' ? 'El servicio de Docker del host remoto está detenido o no responde.'
    : c === 'socket_missing' ? 'No existe el socket de Docker en el host remoto.'
    : 'No se encontró `docker` en el host (o no está en el PATH de una sesión no interactiva).'
  const dockerCmd = c === 'permission_denied' ? sshCommand(profile.target, "'sudo usermod -aG docker \"$USER\"'")
    : c === 'daemon_down' || c === 'socket_missing' ? sshCommand(profile.target, "'sudo systemctl start docker'")
    : sshCommand(profile.target, 'docker version')
  const dockerHint = c === 'permission_denied' ? 'Cierra la sesión SSH y vuelve a entrar para que el grupo surta efecto.'
    : c === 'daemon_down' || c === 'socket_missing' ? 'Para que arranque con el host: sudo systemctl enable docker'
    : 'Necesita Docker CLI ≥ 18.09 en el host remoto.'
  return [
    net,
    step(keyState, 'Clave del host',
      c === 'host_key_changed' ? 'La clave del servidor CAMBIÓ. Podría ser una suplantación (MITM) o que se reinstaló el servidor. DockInng no continúa.' : c === 'host_key_unknown' ? 'La clave del host no está confirmada todavía.' : keyState === 'skip' ? 'Sin comprobar.' : 'La huella coincide con la que confiaste.',
      c === 'host_key_changed' ? { hint: 'Confirma la huella nueva con quien administra el servidor. Si fue una reinstalación legítima, quita a mano la entrada de ese host del archivo known_hosts de DockInng (en su carpeta de datos, no el de ~/.ssh) y vuelve a verificar.' } : c === 'host_key_unknown' ? { hint: 'Vuelve a crear la conexión (Configuración > Añadir conexión) para verificar y confiar en la huella antes de conectar.' } : {}),
    step(authState, 'Autenticación SSH',
      authState === 'fail' ? 'El servidor rechazó la llave (Permission denied, publickey). Revisa la identidad de la conexión.' : authState === 'ok' ? 'El servidor aceptó la llave.' : 'Sin comprobar: hace falta autenticarse antes.',
      authState === 'fail' ? { command: 'ssh-add -l', hint: 'Si la llave tiene passphrase, cárgala en el agente con ssh-add (DockInng no la guarda ni la pide).' } : {}),
    step(dockerState, 'Docker remoto', dockerState === 'fail' ? dockerText : 'Sin comprobar.',
      dockerState === 'fail' ? { command: dockerCmd, hint: dockerHint } : {}),
  ]
}

export function buildDiagnostic(f: Failed, profile: ConnectionProfile): Diagnostic {
  const issue = issueOf(f, profile)
  if (issue === 'ssh') {
    const lead = f.cause === 'host_key_changed'
      ? `La clave del host de ${profile.target} cambió. Por seguridad no se conectó.`
      : `La conexión ${profile.kind === 'tls' ? 'TLS' : 'SSH'} a ${profile.target} no se completó.`
    return { issue, title: `No se pudo conectar con ${profile.name}`, lead, steps: remoteSteps(f, profile) }
  }
  const target = socketPath(f.endpoint)
  if (issue === 'permission') {
    return {
      issue,
      title: 'No se pudo conectar con el motor',
      lead: `DockInng no obtuvo respuesta de ${target} (conexión «${profile.name}»). El socket existe pero tu usuario no puede usarlo.`,
      steps: localSteps(f),
    }
  }
  return {
    issue,
    title: 'El motor de Docker no está en ejecución',
    lead: `Nadie escucha en ${target} (conexión «${profile.name}»). El servicio de Docker está detenido o no está instalado.`,
    steps: localSteps(f),
  }
}

/** Primer comando sugerido de un paso que falla (botón «Copiar comando»). */
export function fixCommandOf(d: Diagnostic): string | null {
  return d.steps.find((s) => s.state === 'fail' && s.command)?.command ?? null
}
