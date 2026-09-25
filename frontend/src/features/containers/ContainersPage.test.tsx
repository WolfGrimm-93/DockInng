import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { setPreviewState } from '@/app/devFlags'
import type { Container } from '@/data/types'
import { fullId } from '@/data/adapters/sim/fixtures'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import ContainersPage from './ContainersPage'

afterEach(resetGlobals)

const EVIL = 'x"><img src=x onerror=alert(1)>'

async function loaded() {
  await screen.findByRole('link', { name: 'tienda-api-1' })
}
const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement

function fake(i: number): Container {
  return {
    id: fullId(String(i).padStart(12, '0')), names: [`bulk-${i}`], image: `img:${i}`, image_id: 'sha256:' + '0'.repeat(64), state: i % 3 ? 'running' : 'exited',
    status: 'Up 1 hour', created: 1, compose_project: i % 2 ? 'alfa' : null, compose_service: null, ports: [], mounts: [], networks: [],
  }
}

describe('ContainersPage', () => {
  it('pinta la lista real del motor simulado con cabecera y contadores', async () => {
    renderView(<ContainersPage />)
    await loaded()
    expect(screen.getByRole('heading', { level: 1, name: 'Contenedores' })).toBeInTheDocument()
    expect(screen.getByText('13 en total · 7 en ejecución')).toBeInTheDocument()
    // Filas = cabecera de la tabla + una por contenedor + una por cabecera de grupo (agrupado por defecto).
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', String(14 + document.querySelectorAll('tr.group-row').length))
    expect(within(rowOf('tienda-api-1')).getByText('En ejecución')).toBeInTheDocument()
    expect(within(rowOf('minio-dev')).getByText('Detenido')).toBeInTheDocument()
  })

  it('filtra por estado y por texto', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('button', { name: /^Detenidos/ }))
    expect(screen.queryByRole('link', { name: 'tienda-api-1' })).toBeNull()
    expect(screen.getByRole('link', { name: 'minio-dev' })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: /^Todos/ }))
    await u.type(screen.getByRole('searchbox'), 'redis')
    expect(screen.getAllByRole('link').filter((a) => a.closest('tbody'))).toHaveLength(1)
    await u.clear(screen.getByRole('searchbox'))
    await u.type(screen.getByRole('searchbox'), 'zzzz-nada')
    expect(await screen.findByText('Ningún contenedor coincide')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Quitar filtros' }))
    expect(screen.getByRole('link', { name: 'tienda-api-1' })).toBeInTheDocument()
  })

  it('selección múltiple con barra masiva y «seleccionar todos»', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('checkbox', { name: 'Seleccionar tienda-web-1' }))
    const bar = screen.getByRole('region', { name: 'Acciones sobre la selección' })
    expect(within(bar).getByText('1 seleccionado')).toBeInTheDocument()
    await u.click(within(bar).getByRole('button', { name: 'Quitar selección' }))
    expect(screen.queryByRole('region', { name: 'Acciones sobre la selección' })).toBeNull()
    await u.click(screen.getByRole('checkbox', { name: 'Seleccionar todos' }))
    expect(screen.getByText('13 seleccionados')).toBeInTheDocument()
  })

  it('selección oculta por el filtro no cuenta ni se ejecuta', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('checkbox', { name: 'Seleccionar tienda-web-1' }))
    await u.click(screen.getByRole('checkbox', { name: 'Seleccionar minio-dev' }))
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Eliminar…' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Eliminar 2 contenedores' })).toBeInTheDocument()
  })

  it('eliminar un contenedor en ejecución: confirmación con --force, volúmenes que NO se borran y ejecución', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('button', { name: 'Eliminar tienda-postgres-1' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Eliminar contenedor' })).toBeInTheDocument()
    expect(within(dlg).getByText(/--force/)).toBeInTheDocument()
    expect(within(dlg).getByText(/no se eliminan/)).toBeInTheDocument()
    expect(within(dlg).getByText('tienda_postgres-datos')).toBeInTheDocument()
    // foco inicial en «Cancelar»
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Cancelar' })).toHaveFocus())
    await u.click(within(dlg).getByRole('button', { name: 'Eliminar contenedor' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'tienda-postgres-1' })).toBeNull())
    expect(await screen.findByText('tienda-postgres-1 eliminado')).toBeInTheDocument()
  })

  it('cancelar la confirmación no elimina nada', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('button', { name: 'Eliminar tienda-redis-1' }))
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByRole('link', { name: 'tienda-redis-1' })).toBeInTheDocument()
    expect(api.sim.world.containers.some((c) => c.names[0] === 'tienda-redis-1')).toBe(true)
  })

  it('eliminación masiva: enumera los contenedores afectados', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    for (const n of ['tienda-redis-1', 'minio-dev', 'tienda-postgres-1']) await u.click(screen.getByRole('checkbox', { name: `Seleccionar ${n}` }))
    await u.click(screen.getByRole('button', { name: 'Eliminar…' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Eliminar 3 contenedores' })).toBeInTheDocument()
    const list = within(dlg).getByRole('list', { name: 'Contenedores a eliminar' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    await u.click(within(dlg).getByRole('button', { name: 'Eliminar 3' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'minio-dev' })).toBeNull())
    expect(screen.queryByRole('region', { name: 'Acciones sobre la selección' })).toBeNull()
  })

  it('acción por fila: estado en curso y error por fila con «Reintentar»', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('button', { name: 'Iniciar mailpit-pruebas' }))
    expect(await within(rowOf('mailpit-pruebas')).findByText(/El puerto 8025 ya lo usa/)).toBeInTheDocument()
    await u.click(within(rowOf('mailpit-pruebas')).getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(within(rowOf('mailpit-pruebas')).getByText('En ejecución')).toBeInTheDocument())
  })

  it('detener y reiniciar pasan por el motor y actualizan el estado', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('button', { name: 'Detener tienda-web-1' }))
    await waitFor(() => expect(within(rowOf('tienda-web-1')).getByText('Detenido')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Reiniciar tienda-web-1' })).toBeDisabled()
  })

  it('agrupar por stack: filas de grupo colapsables (aria-expanded)', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    // Agrupado por defecto; los contenedores sin proyecto quedan fuera de los grupos, sin cabecera «Sin stack».
    const g = screen.getByRole('button', { name: /Stack tienda/ })
    expect(g).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByRole('button', { name: /Sin stack/ })).toBeNull()
    await u.click(g)
    expect(g).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'tienda-api-1' })).toBeNull()
  })

  it('virtualiza: con 1000 contenedores solo pinta una ventana de filas', async () => {
    const api = makeApi()
    for (let i = 0; i < 1000; i++) api.sim.world.containers.push(fake(i))
    renderView(<ContainersPage />, { api })
    await screen.findByText('1013 en total · 707 en ejecución'.replace('707', String(api.sim.world.containers.filter((c) => c.state === 'running').length)))
    const rows = document.querySelectorAll('tbody tr')
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.length).toBeLessThan(80)
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', String(1014 + new Set(api.sim.world.containers.map((c) => c.compose_project).filter(Boolean)).size))
  })

  it('la cabecera de grupo muestra el stack y su red (sin las de sistema)', async () => {
    renderView(<ContainersPage />)
    await loaded()
    const head = screen.getByRole('button', { name: /Stack tienda/ }).closest('tr') as HTMLElement
    // Red propia del proyecto visible como chip; «bridge» (sistema) nunca aparece.
    expect(within(head).getByTitle('Red: tienda_default')).toBeInTheDocument()
    expect(within(head).queryByTitle(/Red: bridge/)).toBeNull()
    expect(within(head).getByText(/en ejecución/)).toBeInTheDocument()
  })

  it('los contenedores sin stack quedan fuera de los grupos, sin cabecera, y los que corren van primero', async () => {
    renderView(<ContainersPage />)
    await loaded()
    const rows = Array.from(document.querySelectorAll('tbody tr')) as HTMLElement[]
    const lastGroup = rows.map((r) => r.classList.contains('group-row')).lastIndexOf(true)
    const after = rows.slice(lastGroup + 1)
    // Tras el último grupo solo hay filas de contenedor (nunca otra cabecera).
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((r) => !r.classList.contains('group-row'))).toBe(true)
    // Dentro de cada tramo, ningún detenido va antes que uno en marcha.
    const txt = (r: HTMLElement) => r.textContent ?? ''
    const firstStopped = after.findIndex((r) => /Detenido|Muerto|Creado/.test(txt(r)))
    if (firstStopped >= 0) expect(after.slice(firstStopped).some((r) => /En ejecución/.test(txt(r)))).toBe(false)
  })

  it('sin agrupar: los que están en marcha van antes que los detenidos', async () => {
    const u = userEvent.setup()
    renderView(<ContainersPage />)
    await loaded()
    await u.click(screen.getByRole('button', { name: 'Agrupar por stack' }))
    expect(document.querySelectorAll('tr.group-row').length).toBe(0)
    const txt = Array.from(document.querySelectorAll('tbody tr')).map((r) => r.textContent ?? '')
    const firstStopped = txt.findIndex((x) => /Detenido/.test(x))
    expect(firstStopped).toBeGreaterThan(0)
    expect(txt.slice(firstStopped).some((x) => /En ejecución/.test(x))).toBe(false)
  })

  it('cada stack tiene su color: la cabecera y sus filas comparten matiz, y stacks distintos difieren', async () => {
    renderView(<ContainersPage />)
    await loaded()
    const hue = (el: HTMLElement) => el.style.getPropertyValue('--grp-h')
    const heads = Array.from(document.querySelectorAll('tr.group-row')) as HTMLElement[]
    expect(heads.length).toBeGreaterThanOrEqual(2)
    const hues = heads.map(hue)
    expect(hues.every((h) => h !== '')).toBe(true)
    expect(new Set(hues).size).toBe(heads.length)
    const tienda = screen.getByRole('button', { name: /Stack tienda/ }).closest('tr') as HTMLElement
    const child = rowOf('tienda-api-1') as HTMLElement
    expect(hue(child)).toBe(hue(tienda))
    // El color es decorativo: el nombre del stack sigue en texto.
    expect(within(tienda).getByText(/Stack tienda/)).toBeInTheDocument()
    // Los sueltos no llevan color de grupo.
    expect(hue(rowOf('traefik-proxy') as HTMLElement)).toBe('')
  })

  it('la franja de consumo muestra CPU, RAM, disco de Docker y GPU con datos, y las cabeceras de stack su consumo', async () => {
    renderView(<ContainersPage />)
    await loaded()
    const strip = screen.getByRole('region', { name: 'Consumo total' })
    for (const l of ['CPU', 'RAM', 'Disco', 'GPU']) expect(within(strip).getByRole('group', { name: l })).toBeInTheDocument()
    // Los datos de sistema y de GPU llegan de forma asíncrona tras conectar.
    await waitFor(() => expect(within(strip).getByRole('group', { name: 'Disco' })).toHaveTextContent(/imágenes .* · volúmenes/))
    await waitFor(() => expect(within(strip).getByRole('group', { name: 'GPU' })).toHaveTextContent(/VRAM .* de /))
    // El nombre de la GPU va en el título (con varias, la lista completa); el texto lleva VRAM y temperatura.
    expect(within(strip).getByRole('group', { name: 'GPU' })).toHaveAttribute('title', expect.stringContaining('NVIDIA'))
    expect(within(strip).getByRole('group', { name: 'CPU' })).toHaveTextContent(/núcleos/)
    expect(within(strip).getByRole('group', { name: 'RAM' })).toHaveTextContent(/del equipo/)
    // Barras accesibles como medidores con valor numérico.
    for (const m of within(strip).getAllByRole('meter')) expect(m).toHaveAttribute('aria-valuenow')
    // Cabecera de stack: CPU y RAM de los que corren + disco aproximado.
    const head = screen.getByRole('button', { name: /Stack tienda/ }).closest('tr') as HTMLElement
    await waitFor(() => expect(within(head).getByText(/^CPU \d/)).toBeInTheDocument())
    expect(within(head).getByText(/^RAM /)).toBeInTheDocument()
    expect(within(head).getByText(/^Disco ≈ /)).toBeInTheDocument()
  })

  it('estado vacío, carga y error de lista', async () => {
    const api = makeApi()
    api.sim.world.containers = []
    const { unmount } = renderView(<ContainersPage />, { api })
    expect(await screen.findByText('Todavía no hay contenedores')).toBeInTheDocument()
    unmount()
    const api2 = makeApi()
    api2.containers.list = () => Promise.reject({ code: 'engine', message: 'boom' })
    renderView(<ContainersPage />, { api: api2 })
    expect(await screen.findByText('No se pudo cargar la lista de contenedores')).toBeInTheDocument()
  })

  it('vista previa de carga: esqueleto con aria-busy', async () => {
    renderView(<ContainersPage />)
    await loaded()
    act(() => setPreviewState('loading'))
    expect(await screen.findByRole('status', { name: 'Cargando datos' })).toHaveAttribute('aria-busy', 'true')
  })

  it('conexión perdida: banner y acciones bloqueadas (aria-disabled), datos conservados', async () => {
    const { api } = renderView(<ContainersPage />)
    await loaded()
    act(() => api.sim.emit({ type: 'connection', status: { state: 'failed', endpoint: 'x', cause: 'other', message: 'x', steps: [] } }))
    expect(await screen.findByText('Se perdió la conexión con el motor')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Eliminar tienda-web-1' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('link', { name: 'tienda-web-1' })).toBeInTheDocument()
  })

  it('nombres maliciosos: se pintan como texto, sin crear elementos', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    api.sim.world.containers[0].names = [EVIL]
    renderView(<ContainersPage />, { api })
    await screen.findByText(EVIL)
    expect(document.querySelector('img')).toBeNull()
    await u.click(screen.getByRole('button', { name: `Eliminar ${EVIL}` }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getAllByText(EVIL).length).toBeGreaterThan(0)
    expect(document.querySelector('img')).toBeNull()
  })

  it('acción masiva con 1000 contenedores: un solo refresco y un solo toast resumen', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    for (let i = 0; i < 1000; i++) api.sim.world.containers.push({ ...fake(i), state: 'exited', status: 'Exited (0) 1 hour ago' })
    let lists = 0
    const orig = api.containers.list.bind(api.containers)
    api.containers.list = (a) => { lists++; return orig(a) }
    renderView(<ContainersPage />, { api })
    await screen.findByText(/1013 en total/)
    const before = lists
    await u.click(screen.getByRole('checkbox', { name: 'Seleccionar todos' }))
    await u.click(screen.getByRole('button', { name: 'Iniciar' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Acciones sobre la selección' })).toBeNull(), { timeout: 15000 })
    expect(lists - before).toBeLessThanOrEqual(3)
    expect(document.querySelectorAll('.toast').length).toBeLessThanOrEqual(2)
    expect(api.sim.world.containers.filter((c) => c.state === 'running').length).toBeGreaterThanOrEqual(1007)
  }, 30000)

  it('texto bidi y nombres de 10 000 caracteres: se sanea lo que se pinta', async () => {
    const api = makeApi()
    api.sim.world.containers[0].names = ['\u202Egpj.exe']
    api.sim.world.containers[1].names = ['n'.repeat(10000)]
    renderView(<ContainersPage />, { api })
    const a = await screen.findByRole('link', { name: 'gpj.exe' })
    expect(a.textContent).toBe('gpj.exe')
    expect(document.body.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/)
    const long = screen.getByRole('link', { name: 'n'.repeat(10000) })
    expect(long.closest('.name-cell')).not.toBeNull()
  })

  it('el diálogo de eliminar muestra el tamaño de los volúmenes montados cuando se conoce (y no lo inventa)', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    renderView(<ContainersPage />, { api })
    await loaded()
    await u.click(screen.getByRole('button', { name: 'Eliminar tienda-redis-1' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('24 MB')).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Cancelar' }))
    api.sim.world.volumes.find((v) => v.name === 'tienda_redis-datos')!.size_bytes = null
    await u.click(screen.getByRole('button', { name: 'Actualizar' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await u.click(screen.getByRole('button', { name: 'Eliminar tienda-redis-1' }))
    const d2 = await screen.findByRole('alertdialog')
    expect(within(d2).getByText('tienda_redis-datos')).toBeInTheDocument()
    expect(within(d2).queryByText('24 MB')).toBeNull()
  })
})
