import { describe, expect, it } from 'vitest'
import { createSimApi } from '.'
import type { ActionRequest } from '../../types'

const mk = () => createSimApi({ latency: 0, tick: 1 })
const idOf = async (api: ReturnType<typeof mk>, name: string) => (await api.containers.list()).find((c) => c.names[0] === name)!.id

describe('adaptador simulado: datos de la plantilla', () => {
  it('contiene los mismos volúmenes de datos que platilla-html', async () => {
    const api = mk()
    const cs = await api.containers.list()
    expect(cs).toHaveLength(13)
    expect(cs.filter((c) => c.state === 'running')).toHaveLength(7)
    expect((await api.images.list())).toHaveLength(12)
    expect((await api.volumes.list())).toHaveLength(7)
    expect((await api.networks.list())).toHaveLength(6)
    expect((await api.connection.profiles()).map((p) => p.name)).toEqual(['Local', 'prod-hetzner', 'staging-lab'])
  })
  it('derivados coherentes: en uso de imágenes, conectados de redes', async () => {
    const api = mk()
    const nets = await api.networks.list()
    expect(nets.find((n) => n.name === 'tienda_default')!.connected).toHaveLength(5)
    expect(nets.find((n) => n.name === 'bridge')!.system).toBe(true)
    const imgs = await api.images.list()
    expect(imgs.filter((i) => i.containers === 0).map((i) => i.repository)).toEqual(['node', '<none>'])
  })
  it('puertos como la plantilla: publicado 8080:80; expuesto sin publicar 6379 y «80, 443»', async () => {
    const cs = await mk().containers.list()
    const p = (n: string) => cs.find((c) => c.names[0] === n)!.ports.map((x) => (x.public_port != null ? `${x.public_port}:${x.private_port}` : `${x.private_port}`)).join(', ')
    expect(p('tienda-web-1')).toBe('8080:80')
    expect(p('tienda-api-1')).toBe('3000:3000')
    expect(p('tienda-redis-1')).toBe('6379')
    expect(p('traefik-proxy')).toBe('80, 443')
    expect(p('minio-dev')).toBe('9000, 9001')
  })
  it('mailpit-pruebas falla al iniciar la primera vez y funciona la segunda', async () => {
    const api = mk()
    const id = await idOf(api, 'mailpit-pruebas')
    await expect(api.containers.start(id)).rejects.toMatchObject({ code: 'conflict' })
    await api.containers.start(id)
    expect((await api.containers.list()).find((c) => c.id === id)!.state).toBe('running')
  })
  it('emite eventos al cambiar el estado', async () => {
    const api = mk()
    const seen: string[] = []
    api.events.subscribe((f) => f.type === 'events' && seen.push(...f.items.map((i) => i.action)))
    await api.containers.stop(await idOf(api, 'traefik-proxy'))
    expect(seen).toContain('die')
  })
})

describe('adaptador simulado: política plan → ticket → execute', () => {
  it('eliminar contenedores: confirm, avisos server-side y ejecución de un solo uso', async () => {
    const api = mk()
    const id = await idOf(api, 'tienda-postgres-1')
    const plan = await api.actions.plan({ type: 'remove_containers', ids: [id] })
    expect(plan.decision).toEqual({ type: 'confirm' })
    expect(plan.warnings.map((w) => w.type)).toEqual(['running_force', 'volumes_kept'])
    expect(plan.ticket).toBeTruthy()
    const out = await api.actions.execute(plan.ticket!)
    expect(out.succeeded).toHaveLength(1)
    expect((await api.containers.list()).some((c) => c.id === id)).toBe(false)
    // replay del mismo ticket: rechazado
    await expect(api.actions.execute(plan.ticket!)).rejects.toMatchObject({ code: 'ticket_invalid' })
  })
  it('volumen: confirmación escrita con el nombre; typed incorrecto no consume el ticket', async () => {
    const api = mk()
    const plan = await api.actions.plan({ type: 'remove_volume', name: 'respaldos-pg' })
    expect(plan.decision).toEqual({ type: 'confirm_typed', expected: 'respaldos-pg' })
    await expect(api.actions.execute(plan.ticket!, 'otro')).rejects.toMatchObject({ code: 'typed_mismatch' })
    await expect(api.actions.execute(plan.ticket!, '  respaldos-pg ')).resolves.toMatchObject({ freed_bytes: expect.any(Number) })
  })
  it('prune de volúmenes exige ELIMINAR (sensible a mayúsculas) y borra solo los sin usar', async () => {
    const api = mk()
    const plan = await api.actions.plan({ type: 'prune_volumes' })
    expect(plan.decision).toEqual({ type: 'confirm_typed', expected: 'ELIMINAR' })
    expect(plan.affected.map((a) => a.name)).toEqual(['respaldos-pg', '8c1f0e3a7b52d94e6f01a3c8b5d72e90'])
    await expect(api.actions.execute(plan.ticket!, 'eliminar')).rejects.toMatchObject({ code: 'typed_mismatch' })
    await api.actions.execute(plan.ticket!, 'ELIMINAR')
    expect((await api.volumes.list())).toHaveLength(5)
  })
  it('limpiar todo el sistema: Deny · Forbidden y sin ticket', async () => {
    const plan = await mk().actions.plan({ type: 'prune_system' })
    expect(plan.decision).toEqual({ type: 'deny', reason: 'forbidden' })
    expect(plan.ticket).toBeNull()
  })
  it('redes: las del sistema y las que tienen contenedores devuelven conflict', async () => {
    const api = mk()
    await expect(api.actions.plan({ type: 'remove_network', id: 'bridge' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(api.actions.plan({ type: 'remove_network', id: 'tienda_default' })).rejects.toMatchObject({ code: 'conflict' })
  })
  it('cancel libera el ticket', async () => {
    const api = mk()
    const plan = await api.actions.plan({ type: 'prune_images' } satisfies ActionRequest)
    await api.actions.cancel(plan.ticket!)
    await expect(api.actions.execute(plan.ticket!)).rejects.toMatchObject({ code: 'ticket_invalid' })
  })
})

describe('adaptador simulado: mutateWorld=false (modo Tauri)', () => {
  it('crear contenedor no inserta datos falsos', async () => {
    const api = createSimApi({ latency: 0, mutateWorld: false })
    const r = await api.create.submit({ image: 'nginx', name: 'x', ports: [], volumes: [], env: [], network: 'bridge', restart: 'no' }, 'start')
    expect(r).toEqual({ simulated: true, name: 'x' })
    expect((await api.containers.list())).toHaveLength(13)
  })
})

describe('terminal simulada', () => {
  it('ejecuta comandos de la demo y no rompe con nombres de prototipo', async () => {
    const api = mk()
    const t = api.exec.open('abc123abc123')
    const out: string[] = []
    t.onData((c) => out.push(c))
    t.write('pwd')
    t.write('constructor')
    expect(out[0]).toBe('/app\n')
    expect(out[1]).toContain('no se encontró la orden')
  })
})
