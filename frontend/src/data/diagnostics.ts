// Diagnóstico de conexión en español a partir de ConnectionStatus (backend: PLAN §1.9 — los textos y
// comandos sugeridos viven en el frontend, indexados por causa/paso). Contrato:
//   buildDiagnostic(failed, profile) -> Diagnostic        (paneles «permiso», «daemon», «ssh» de la plantilla)
//   issueOf(failed, profile)         -> 'permission'|'daemon'|'ssh'
//   pendingDiagnostic / DIAG_TAGS    etiquetas de los pasos
import type { ConnectionProfile, ConnectionStatus, DiagStep, DiagStepId, Diagnostic } from './types'

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

function hostOf(target: string): string {
  const m = target.match(/@([^:/]+)/) ?? target.match(/^[a-z]+:\/\/([^:/]+)/)
  return m ? m[1] : target
}

export function buildDiagnostic(f: Failed, profile: ConnectionProfile): Diagnostic {
  const issue = issueOf(f, profile)
  if (issue === 'ssh') {
    const host = hostOf(profile.target)
    return {
      issue,
      title: `No se pudo conectar con ${profile.name}`,
      lead: `La conexión SSH a ${profile.target} no se completó.`,
      steps: [
        { state: 'ok', title: 'Red', detail: `El host ${host} responde en el puerto 22.`, tag: TAG.ok },
        {
          state: 'fail',
          title: 'Autenticación SSH',
          detail: 'El servidor rechazó la llave (Permission denied, publickey). Revisa el alias en ~/.ssh/config.',
          command: `ssh ${profile.name} docker info`,
          hint: 'Si funciona en la terminal, comprueba que la llave esté cargada con ssh-add.',
          tag: TAG.fail,
        },
        { state: 'skip', title: 'Socket remoto', detail: 'Sin comprobar: hace falta autenticarse antes.', tag: TAG.skip },
      ],
    }
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
