import { describe, expect, it } from 'vitest'
import { buildDiagnostic, connectionFailText, fixCommandOf, issueOf } from './diagnostics'
import type { ConnectionCause, ConnectionProfile, ConnectionStatus } from './types'

const local: ConnectionProfile = { id: 'local', name: 'Local', target: 'unix:///var/run/docker.sock', kind: 'local', icon: 'monitor', remote: false, version: '', simulated: false }
type Failed = Extract<ConnectionStatus, { state: 'failed' }>
const perm: Failed = { state: 'failed', endpoint: local.target, cause: 'permission_denied', message: 'x', steps: [
  { id: 'socket', status: 'ok', detail: '' }, { id: 'permissions', status: 'fail', detail: '' }, { id: 'daemon', status: 'skipped', detail: '' }] }

describe('diagnóstico', () => {
  it('permiso: 3 pasos con el comando del grupo docker', () => {
    const d = buildDiagnostic(perm, local)
    expect(d.issue).toBe('permission')
    expect(d.title).toBe('No se pudo conectar con el motor')
    expect(d.lead).toContain('/var/run/docker.sock')
    expect(fixCommandOf(d)).toBe('sudo usermod -aG docker $USER')
  })
  it('daemon caído y causa desconocida se tratan como daemon', () => {
    expect(issueOf({ ...perm, cause: 'daemon_down' }, local)).toBe('daemon')
    expect(issueOf({ ...perm, cause: 'other' }, local)).toBe('daemon')
    expect(issueOf({ ...perm, cause: 'socket_missing' }, local)).toBe('daemon')
  })
  it('perfil remoto = ssh con el alias en el comando', () => {
    const p: ConnectionProfile = { ...local, id: 's', name: 'staging-lab', kind: 'ssh', remote: true, target: 'ssh://ops@192.168.1.40' }
    const d = buildDiagnostic({ ...perm, cause: 'other', steps: [] }, p)
    expect(d.issue).toBe('ssh')
    expect(d.steps[0].detail).toContain('192.168.1.40')
    expect(fixCommandOf(d)).toBe('ssh ops@192.168.1.40 docker info')
  })
})

describe('revisión fase 4: diagnóstico remoto', () => {
  const p: ConnectionProfile = { ...local, id: 's', name: "x'; rm -rf ~ #", kind: 'ssh', remote: true, target: 'ssh://deploy@203.0.113.10' }
  const f = (cause: ConnectionCause) => buildDiagnostic({ ...perm, cause, message: '', steps: [] }, p)
  it('M-7: permission_denied y daemon_down en un remoto dejan «Docker remoto» en fail con el comando adecuado', () => {
    for (const [cause, cmd] of [['permission_denied', /usermod -aG docker/], ['daemon_down', /systemctl start docker/]] as const) {
      const d = f(cause)
      expect(d.steps.map((s) => s.state)).toEqual(['ok', 'ok', 'ok', 'fail'])
      expect(d.steps[3].title).toBe('Docker remoto')
      expect(d.steps[3].command).toMatch(cmd)
      expect(d.steps[3].command).toMatch(/^ssh deploy@203\.0\.113\.10 /)
    }
  })
  it('B-7: el nombre visible nunca se interpola en un comando sugerido (rama genérica incluida)', () => {
    const d = f('other')
    expect(JSON.stringify(d.steps)).not.toContain('rm -rf')
    expect(d.steps[1].command).toBe('ssh deploy@203.0.113.10 docker info')
  })
  it('shq/sshCommand: entrecomilla lo raro y respeta puerto e IPv6', async () => {
    const { shq, sshCommand } = await import('./diagnostics')
    expect(shq("a b'c")).toBe("'a b'\\''c'")
    expect(shq('user@host')).toBe('user@host')
    expect(sshCommand('ssh://[::1]:2200', 'docker info')).toBe("ssh -p 2200 '[::1]' docker info")
  })
})

describe('diagnóstico remoto por causa (Ola 2)', () => {
  const p: ConnectionProfile = { ...local, id: 's', name: 'prod', kind: 'ssh', remote: true, target: 'ssh://deploy@203.0.113.10:2222' }
  const f = (cause: ConnectionCause, message = '') => buildDiagnostic({ ...perm, cause, message, steps: [] }, p)
  const failing = (d: ReturnType<typeof f>) => d.steps.filter((s) => s.state === 'fail').map((s) => s.title)
  it('cada causa marca UN paso como fallido y los posteriores como pendientes', () => {
    expect(failing(f('host_key_unknown'))).toEqual(['Clave del host'])
    expect(failing(f('host_key_changed'))).toEqual(['Clave del host'])
    expect(failing(f('auth_failed'))).toEqual(['Autenticación SSH'])
    expect(failing(f('unreachable', 'timeout'))).toEqual(['Red'])
    expect(failing(f('remote_docker_missing'))).toEqual(['Docker remoto'])
    expect(f('auth_failed').steps.find((s) => s.title === 'Docker remoto')?.state).toBe('skip')
  })
  it('clave cambiada: aviso de suplantación, sin comando que edite ~/.ssh y con el motivo en la introducción', () => {
    const d = f('host_key_changed')
    expect(d.lead).toMatch(/cambió/)
    expect(d.steps[1].detail).toMatch(/suplantación/)
    expect(JSON.stringify(d)).not.toMatch(/ssh-keygen -R/)
    expect(d.steps[1].hint).toMatch(/no el de ~\/\.ssh/) // nunca manda a editar el known_hosts del usuario
  })
  it('el puerto de la conexión aparece en el paso de red y el host docker remoto trae comando', () => {
    expect(f('auth_failed').steps[0].detail).toContain('2222')
    expect(f('remote_docker_missing').steps[3].command).toBe('ssh -p 2222 deploy@203.0.113.10 docker version')
  })
  it('TLS: certificados inválidos se explican sin hablar de SSH', () => {
    const t: ConnectionProfile = { ...p, kind: 'tls', target: 'tcp://10.0.0.5:2376' }
    const d = buildDiagnostic({ ...perm, cause: 'tls_invalid', message: 'x509', steps: [] }, t)
    expect(d.lead).toMatch(/TLS/)
    expect(d.steps.map((s) => s.title)).toContain('Certificados TLS')
    expect(JSON.stringify(d)).not.toContain('SSH')
  })
  it('connectionFailText prefiere la causa clasificada y conserva el detalle del motor', () => {
    expect(connectionFailText('tls_invalid', 'x509')).toMatch(/certificado.*\(x509\)/)
    expect(connectionFailText(null, 'boom')).toBe('boom')
    expect(connectionFailText('other', 'boom')).toBe('boom')
  })
})
