// Exportar grupos en el simulador: produce una descarga con el nombre fijo y el documento de grupos.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSimApi } from '.'

afterEach(() => { vi.restoreAllMocks() })

describe('sim: exportar grupos', () => {
  it('descarga dockinng-grupos.json y devuelve su nombre', async () => {
    const api = createSimApi({ latency: 0, tick: 1 })
    await api.groups.mutate({ type: 'create_group', name: 'API', hue: null })
    const creado: Blob[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { creado.push(b); return 'blob:test' }, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const nombre = await api.groups.exportGroups()
    expect(nombre).toBe('dockinng-grupos.json')
    expect(click).toHaveBeenCalledTimes(1)
    const texto = await creado[0].text()
    const doc = JSON.parse(texto)
    expect(doc.format).toBe('dockinng-groups')
    expect(doc.groups.map((g: { name: string }) => g.name)).toEqual(['API'])
    vi.unstubAllGlobals()
  })
})
