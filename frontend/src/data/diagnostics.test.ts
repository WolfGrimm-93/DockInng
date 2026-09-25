import { describe, expect, it } from 'vitest'
import { buildDiagnostic, fixCommandOf, issueOf } from './diagnostics'
import type { ConnectionProfile, ConnectionStatus } from './types'

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
    expect(fixCommandOf(d)).toBe('ssh staging-lab docker info')
  })
})
