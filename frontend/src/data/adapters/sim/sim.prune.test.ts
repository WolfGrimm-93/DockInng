// Operación prune_assignments en el simulador: quita solo las asignaciones huérfanas de la conexión dada.
import { describe, expect, it } from 'vitest'
import { createSimApi } from '.'

const mk = () => createSimApi({ latency: 0, tick: 1 })

describe('sim: prune_assignments', () => {
  it('quita las asignaciones huérfanas de la conexión y conserva las vivas y las de otras conexiones', async () => {
    const api = mk()
    const snap = await api.groups.mutate({ type: 'create_group', name: 'API', hue: null })
    const id = snap.groups[0].id
    await api.groups.mutate({ type: 'assign', connection_id: 'local', names: ['web', 'viejo'], group_id: id })
    const after = await api.groups.mutate({ type: 'prune_assignments', connection_id: 'local', live_names: ['web'] })
    expect(after.assignments.map((a) => a.container_name).sort()).toEqual(['web'])
  })
  it('una conexión inexistente se rechaza', async () => {
    const api = mk()
    await expect(api.groups.mutate({ type: 'prune_assignments', connection_id: 'no-existe', live_names: [] })).rejects.toMatchObject({ code: 'not_found' })
  })
})
