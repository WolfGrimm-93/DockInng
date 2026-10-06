// UI de la Ola 2: HostKeyDialog, registries (secreto), limpieza guiada, build, selector de conexión, diálogos con conexión remota,
// avisos RemoteBind y escape de texto no confiable. Motor simulado (misma API que el real).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Providers } from '@/app/providers'
import { AppShell } from '@/app/AppShell'
import { HostKeyDialog } from '@/components/shared/HostKeyDialog'
import { createSimApi } from '@/data/adapters/sim'
import { useEngineStoreApi } from '@/data/store/hooks'
import type { HostKeyProbe } from '@/data/types'
import { toast } from '@/lib/toastStore'
import BuildPage from './images/BuildPage'
import ConnNewPage from './settings/ConnNewPage'
import CleanupPage from './cleanup/CleanupPage'
import { sizeText, summarize, toSelection } from './cleanup/cleanupModel'
import ContainersPage from './containers/ContainersPage'
import CreateContainerPage from './containers/CreateContainerPage'
import PullPage from './images/PullPage'
import { RegistriesSection } from './settings/RegistriesSection'
import SettingsPage from './settings/SettingsPage'
import StackEditPage from './stacks/StackEditPage'
import { makeApi, renderView, resetGlobals } from './testUtils'

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
afterEach(() => { resetGlobals(); toast.clear() })

const unknown: HostKeyProbe = { key_type: 'ssh-ed25519', fingerprint_sha256: 'SHA256:abc123', state: 'unknown' }
const changed: HostKeyProbe = { key_type: 'ssh-ed25519', fingerprint_sha256: 'SHA256:NUEVA', state: 'changed', known_fingerprint_sha256: 'SHA256:VIEJA' }

describe('HostKeyDialog', () => {
  const open = (probe: HostKeyProbe, extra: { onTrust?: () => void; onClose?: () => void } = {}) =>
    render(<HostKeyDialog probe={probe} host="srv.example" port={2222} onTrust={extra.onTrust ?? (() => {})} onClose={extra.onClose ?? (() => {})} />)
  it('unknown: muestra tipo, huella y puerto; foco en Cancelar; «Confiar y continuar» llama a onTrust', async () => {
    const u = userEvent.setup()
    const onTrust = vi.fn()
    open(unknown, { onTrust })
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('Confirmar la huella del host')).toBeInTheDocument()
    expect(within(dlg).getByText('SHA256:abc123')).toBeInTheDocument()
    expect(within(dlg).getByText('ssh-ed25519')).toBeInTheDocument()
    expect(within(dlg).getByText(/srv\.example:2222/)).toBeInTheDocument()
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Cancelar' })).toHaveFocus())
    await u.click(within(dlg).getByRole('button', { name: 'Confiar y continuar' }))
    expect(onTrust).toHaveBeenCalledTimes(1)
  })
  it('changed: bloqueo con ambas huellas y SIN botón de aceptar (ni por teclado)', async () => {
    const u = userEvent.setup()
    const onTrust = vi.fn()
    const onClose = vi.fn()
    open(changed, { onTrust, onClose })
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('La clave del host cambió')).toBeInTheDocument()
    expect(within(dlg).getByText('SHA256:NUEVA')).toBeInTheDocument()
    expect(within(dlg).getByText('SHA256:VIEJA')).toBeInTheDocument()
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Conexión bloqueada')
    expect(within(dlg).queryByRole('button', { name: /Confiar|Aceptar|Continuar/ })).toBeNull()
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Cerrar' })).toHaveFocus()) // el foco inicial nunca cae en una acción de confiar
    await u.click(within(dlg).getByRole('button', { name: 'Cerrar' }))
    expect(onTrust).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
  it('changed con onForget: «Olvidar» exige escribir el nombre exacto del host y no confía en la clave nueva', async () => {
    const u = userEvent.setup()
    const onForget = vi.fn()
    const onTrust = vi.fn()
    render(<HostKeyDialog probe={changed} host="srv.example" port={22} onTrust={onTrust} onForget={onForget} onClose={() => {}} />)
    const dlg = await screen.findByRole('alertdialog')
    const boton = within(dlg).getByRole('button', { name: 'Olvidar clave guardada' })
    const campo = within(dlg).getByRole('textbox')
    expect(boton).toBeDisabled()
    await u.type(campo, 'otro-host')
    expect(boton).toBeDisabled()
    await u.clear(campo)
    await u.type(campo, '  SRV.example ')
    expect(boton).toBeEnabled()
    await u.click(boton)
    expect(onForget).toHaveBeenCalledTimes(1)
    expect(onTrust).not.toHaveBeenCalled()
  })
  it('un host/huella con HTML se pinta como texto', async () => {
    render(<HostKeyDialog probe={{ ...unknown, fingerprint_sha256: '<img src=x onerror=alert(1)>' }} host="<b>x</b>" port={22} onTrust={() => {}} onClose={() => {}} />)
    await screen.findByRole('alertdialog')
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('dialog b, [role=alertdialog] b:not(:has(*))')).not.toBeNull() // <b> solo de los textos propios
    expect(screen.getByTestId('fingerprint').textContent).toContain('<img')
  })
  it('sin probe no hay diálogo', () => {
    render(<HostKeyDialog probe={null} host="h" port={22} onTrust={() => {}} onClose={() => {}} />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
  it('devuelve el foco al cerrar (Esc en unknown)', async () => {
    const u = userEvent.setup()
    function Host() {
      const [p, setP] = useState<HostKeyProbe | null>(null)
      return <><button onClick={() => setP(unknown)}>abrir</button><HostKeyDialog probe={p} host="h" port={22} onTrust={() => {}} onClose={() => setP(null)} /></>
    }
    render(<Host />)
    const btn = screen.getByRole('button', { name: 'abrir' })
    await u.click(btn)
    await screen.findByRole('alertdialog')
    await u.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(btn).toHaveFocus())
  })
})

describe('Registros (credenciales)', () => {
  it('el secreto es type=password, sale del estado al enviar, no se muestra en la lista y el diálogo pide confirmar al eliminar', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<RegistriesSection />)
    expect(await screen.findByText('Sin registros')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Añadir registro' }))
    const secret = await screen.findByLabelText(/Contraseña o token/)
    expect(secret).toHaveAttribute('type', 'password')
    expect(secret).toHaveAttribute('autocomplete', 'new-password')
    await u.type(screen.getByLabelText('Servidor'), 'ghcr.io')
    await u.type(screen.getByLabelText('Usuario'), 'casaluna')
    await u.type(secret, 'S3CRETO-XYZ')
    await u.click(screen.getByRole('button', { name: 'Guardar en el llavero' }))
    expect(await screen.findByText('ghcr.io')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('S3CRETO')
    expect(JSON.stringify(await api.registries.list())).not.toContain('S3CRETO')
    expect(screen.queryByLabelText(/Contraseña o token/)).toBeNull()
    // Reabrir el formulario: el secreto anterior no persiste.
    await u.click(screen.getByRole('button', { name: 'Añadir registro' }))
    expect((await screen.findByLabelText(/Contraseña o token/) as HTMLInputElement).value).toBe('')
    await u.click(screen.getByRole('button', { name: 'Cancelar' }))
    // Probar
    await u.click(screen.getByRole('button', { name: 'Probar' }))
    expect(await screen.findByText('Credenciales válidas')).toBeInTheDocument()
    // Eliminar exige confirmación.
    await u.click(screen.getByRole('button', { name: 'Eliminar las credenciales de ghcr.io' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Eliminar credenciales del registro' })).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Cancelar' }))
    expect(await api.registries.list()).toHaveLength(1)
    await u.click(screen.getByRole('button', { name: 'Eliminar las credenciales de ghcr.io' }))
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Eliminar credenciales' }))
    await waitFor(async () => expect(await api.registries.list()).toHaveLength(0))
  })
  it('un error del backend (servidor inválido) se muestra dentro del diálogo y no lo cierra', async () => {
    const u = userEvent.setup()
    renderView(<RegistriesSection />)
    await u.click(await screen.findByRole('button', { name: 'Añadir registro' }))
    await u.type(await screen.findByLabelText('Servidor'), 'no valido!')
    await u.type(screen.getByLabelText('Usuario'), 'u')
    await u.type(screen.getByLabelText(/Contraseña o token/), 'p')
    await u.click(screen.getByRole('button', { name: 'Guardar en el llavero' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/servidor del registro no es válido/)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })
  it('presetServer abre el formulario con el servidor rellenado (enlace desde una descarga rechazada)', async () => {
    renderView(<SettingsPage />, { hash: '#settings?tab=registries&registry=ghcr.io' })
    expect(((await screen.findByLabelText('Servidor')) as HTMLInputElement).value).toBe('ghcr.io')
  })
  it('la descarga con auth_required ofrece «Añadir credenciales del registro» hacia la pestaña Registros', async () => {
    const u = userEvent.setup()
    renderView(<PullPage />, { hash: '#pull?image=ghcr.io/casaluna/private:1' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    const link = await screen.findByRole('link', { name: 'Añadir credenciales del registro' }, { timeout: 5000 })
    expect(link).toHaveAttribute('href', '#settings?tab=registries&registry=ghcr.io')
  })
})

describe('Configuración: conexiones', () => {
  it('lista con insignias (Local, Remota·SSH, Simulada); no se elimina la local; eliminar pide confirmar y la quita', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<SettingsPage />, { hash: '#settings' })
    expect(await screen.findByText('Activa')).toBeInTheDocument()
    expect(screen.getAllByText('Remota · SSH').length).toBe(2)
    expect(screen.queryByRole('button', { name: 'Más opciones de Local' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Más opciones de prod-hetzner' }))
    await u.click(await screen.findByRole('menuitem', { name: /Eliminar…/ }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Eliminar conexión' })).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Cancelar' }))
    expect((await api.connections.list())).toHaveLength(3)
    await u.click(screen.getByRole('button', { name: 'Más opciones de prod-hetzner' }))
    await u.click(await screen.findByRole('menuitem', { name: /Eliminar…/ }))
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Eliminar conexión' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Más opciones de prod-hetzner' })).toBeNull())
    expect((await api.connections.list())).toHaveLength(2)
  })
})

describe('Selector de conexión y diálogos con conexión remota', () => {
  const mount = () => {
    const api = createSimApi({ latency: 0, tick: 1 })
    render(<Providers api={api}><AppShell /></Providers>)
    return api
  }
  it('cambia a una conexión remota; muestra insignias y «Conectando…» mientras dura', async () => {
    const u = userEvent.setup()
    window.location.hash = ''
    const api = mount()
    const orig = api.connections.select
    let release: () => void = () => {}
    api.connections.select = (id) => new Promise((res) => { release = () => res(orig(id)) })
    await screen.findByRole('link', { name: 'tienda-api-1' })
    await u.click(screen.getByRole('button', { name: /Cambiar de conexión\. Actual: Local/ }))
    const item = await screen.findByRole('menuitemradio', { name: /prod-hetzner/ })
    expect(within(item).getByText('SSH')).toBeInTheDocument()
    expect(within(item).getByText('simulada')).toBeInTheDocument()
    await u.click(item)
    expect(await screen.findByRole('button', { name: /Conectando con prod-hetzner/ })).toHaveAttribute('aria-busy', 'true')
    await act(async () => { release() })
    expect(await screen.findByRole('button', { name: /Actual: prod-hetzner/ })).toBeInTheDocument()
    window.location.hash = ''
  })
  it('el diálogo destructivo nombra la conexión activa cuando es remota (y no en local)', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    const { unmount } = renderView(<ContainersPage />, { api })
    await u.click(await screen.findByRole('button', { name: /^Eliminar minio-dev$/ }))
    expect(within(await screen.findByRole('alertdialog')).queryByText(/Conexión remota/)).toBeNull()
    await u.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
    unmount()
    const api2 = makeApi()
    await api2.connections.select('prod')
    renderView(<ContainersPage />, { api: api2 })
    await u.click(await screen.findByRole('button', { name: /^Eliminar minio-dev$/ }))
    const note = await within(await screen.findByRole('alertdialog')).findByText(/Conexión remota/)
    expect(note.closest('[role=note]')).toHaveTextContent(/prod-hetzner/)
    expect(note.closest('[role=note]')).toHaveTextContent(/no en el tuyo/)
  })
})

describe('Avisos RemoteBind', () => {
  it('Crear contenedor: con una conexión remota y un bind absoluto se avisa tras el plan (banner persistente)', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    await api.connections.select('prod')
    renderView(<CreateContainerPage />, { api, hash: '#create?image=nginx:1.27-alpine' })
    await screen.findByRole('button', { name: 'Solo crear' })
    await u.clear(screen.getByLabelText('Puerto del equipo 1'))
    await u.type(screen.getByLabelText('Origen (volumen o ruta) 1'), '/srv/datos')
    await u.type(screen.getByLabelText('Ruta en el contenedor 1'), '/d')
    await u.click(screen.getByRole('button', { name: 'Solo crear' }))
    expect((await screen.findAllByText('Montajes en el servidor remoto')).length).toBeGreaterThan(0) // toast: la página navega tras crear
  })
  it('Editar stack: con conexión remota, una ruta relativa muestra el aviso remote_bind con la ruta local resuelta', async () => {
    const api = makeApi()
    await api.connections.select('prod')
    const tienda = await api.stacks.read('tienda')
    await api.stacks.save('tienda', { yaml: tienda.yaml.replace(/(services:\n)/, '$1') + '\n', env: tienda.env, expectedRevision: tienda.revision })
    // El YAML de ejemplo ya usa un bind relativo (./uploads); si no, el validador simulado no lo vería.
    const v = await api.stacks.validate('tienda', (await api.stacks.read('tienda')).yaml, '')
    if (!v.risks.some((r) => r.type === 'remote_bind')) await api.stacks.save('tienda', { yaml: 'services:\n  web:\n    image: nginx\n    volumes:\n      - ./uploads:/x\n', env: '', expectedRevision: (await api.stacks.read('tienda')).revision })
    renderView(<StackEditPage />, { api, hash: '#stack-edit?stack=tienda' })
    expect(await screen.findByText(/Conexión remota: rutas relativas \(prod-hetzner\)/)).toBeInTheDocument()
    expect(screen.getByText(/su propio disco/)).toBeInTheDocument()
  })
})

describe('Limpieza guiada (CleanupPage)', () => {
  it('categorías con estimaciones honestas; volúmenes sin marcar; resumen; la confirmación con volúmenes es escrita', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<CleanupPage />, { hash: '#cleanup' })
    expect(await screen.findByRole('heading', { name: 'Limpieza', level: 1 })).toBeInTheDocument()
    const vols = await screen.findByRole('region', { name: 'Volúmenes sin usar' }, { timeout: 3000 })
    for (const cb of within(vols).getAllByRole('checkbox').slice(1)) expect(cb).not.toBeChecked() // ningún volumen marcado por defecto
    expect(within(vols).getAllByText('Riesgo alto: datos').length).toBeGreaterThan(0)
    expect(within(vols).getAllByText('tamaño desconocido').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\(aprox\.\)/).length).toBeGreaterThan(0) // imágenes: cota superior
    const cache = screen.getByRole('region', { name: 'Caché de construcción' })
    expect(within(cache).getByText(/Solo informativo/)).toBeInTheDocument()
    expect(within(cache).queryByRole('checkbox')).toBeNull()
    const bar = screen.getByRole('region', { name: 'Resumen de la selección' })
    expect(bar).toHaveTextContent(/elemento(s)? seleccionado(s)?/)
    expect(bar).not.toHaveTextContent(/volumen/)
    // Marcar un volumen cambia el nivel: confirmación escrita.
    const first = within(vols).getAllByRole('checkbox')[1]
    await u.click(first)
    expect(bar).toHaveTextContent(/incluye 1 volumen\(es\): confirmación escrita/)
    await u.click(within(bar).getByRole('button', { name: 'Revisar y limpiar' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText(/Confirmación humana obligatoria/)).toBeInTheDocument()
    const ok = within(dlg).getByRole('button', { name: /Eliminar \d+ elementos/ })
    expect(ok).toBeDisabled()
    await u.type(within(dlg).getByRole('textbox'), 'ELIMINAR')
    const volsBefore = (await api.volumes.list()).length
    await u.click(ok)
    await waitFor(async () => expect((await api.volumes.list()).length).toBe(volsBefore - 1))
  })
  it('sin volúmenes la confirmación es simple (nivel Confirmar) y lo ajeno no cambia', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<CleanupPage />, { hash: '#cleanup' })
    await screen.findByRole('region', { name: 'Volúmenes sin usar' }, { timeout: 3000 })
    const before = { v: (await api.volumes.list()).length, i: (await api.images.list()).length }
    await u.click(within(screen.getByRole('region', { name: 'Resumen de la selección' })).getByRole('button', { name: 'Revisar y limpiar' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).queryByRole('textbox')).toBeNull()
    expect(within(dlg).getByText(/Nunca se ejecuta/)).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: /Eliminar \d+ elementos/ }))
    expect((await screen.findAllByText(/elementos eliminados/, undefined, { timeout: 4000 })).length).toBeGreaterThan(0)
    expect((await api.volumes.list()).length).toBe(before.v)
    expect((await api.images.list()).length).toBe(before.i - 1) // solo la imagen COLGADA venía marcada; las sin usar con nombre no
  })
  it('el filtro de antigüedad vuelve a pedir el informe', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    const spy = vi.spyOn(api.system, 'cleanupReport')
    renderView(<CleanupPage />, { api, hash: '#cleanup' })
    await screen.findByRole('region', { name: 'Volúmenes sin usar' }, { timeout: 3000 })
    expect(spy).toHaveBeenLastCalledWith({ minAgeDays: 30 })
    await u.selectOptions(screen.getByLabelText('Imágenes sin usar:'), '90')
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ minAgeDays: 90 }))
  })
  it('un fallo del informe muestra error con «Reintentar»', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    let fail = true
    const orig = api.system.cleanupReport
    api.system.cleanupReport = async (o) => { if (fail) throw { code: 'engine', message: 'df falló' }; return orig(o) }
    renderView(<CleanupPage />, { api, hash: '#cleanup' })
    expect(await screen.findByText('No se pudo generar el informe')).toBeInTheDocument()
    fail = false
    await u.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByRole('region', { name: 'Volúmenes sin usar' })).toBeInTheDocument()
  })
  it('un nombre con HTML se pinta como texto', async () => {
    const api = makeApi()
    api.sim.world.networks.push({ id: 'z'.repeat(64), name: '<img src=x onerror=alert(1)>', driver: 'bridge', scope: 'local', subnets: [], internal: false, system: false, connected: [], compose_project: null })
    renderView(<CleanupPage />, { api, hash: '#cleanup' })
    await screen.findByRole('region', { name: 'Redes sin usar' }, { timeout: 3000 })
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })
})

describe('CleanupPage: funciones puras', () => {
  const report = {
    generated_at: 'x', unknown_count: 1, total_reclaimable_bytes: 1500,
    categories: [
      { id: 'stopped_containers', executable: true, reclaimable_bytes: 1000, items: [{ kind: 'container', id: 'c1', name: 'a', size_bytes: 1000, estimate: 'exact', reason: '', risk: 'low', selected_by_default: true }] },
      { id: 'unused_images', executable: true, reclaimable_bytes: 500, items: [{ kind: 'image', id: 'i1', name: 'b', size_bytes: 500, estimate: 'upper_bound', reason: '', risk: 'medium', selected_by_default: false }] },
      { id: 'unused_volumes', executable: true, reclaimable_bytes: null, items: [{ kind: 'volume', id: 'v1', name: 'c', size_bytes: null, estimate: 'unknown', reason: '', risk: 'high', selected_by_default: false }] },
      { id: 'build_cache', executable: false, reclaimable_bytes: 9999, items: [{ kind: 'image', id: 'x', name: 'x', size_bytes: 9, estimate: 'exact', reason: '', risk: 'low', selected_by_default: true }] },
    ],
  } as const
  it('toSelection agrupa por tipo e ignora categorías no ejecutables', () => {
    expect(toSelection(report as never, new Set(['container:c1', 'volume:v1', 'image:x']))).toEqual({ containers: ['c1'], images: [], volumes: ['v1'], networks: [] })
  })
  it('summarize suma solo tamaños conocidos, marca aproximado y cuenta desconocidos y volúmenes', () => {
    expect(summarize(report as never, new Set(['container:c1']))).toEqual({ count: 1, bytes: 1000, approx: false, unknown: 0, volumes: 0 })
    expect(summarize(report as never, new Set(['container:c1', 'image:i1', 'volume:v1']))).toEqual({ count: 3, bytes: 1500, approx: true, unknown: 1, volumes: 1 })
  })
  it('sizeText nunca inventa un tamaño', () => {
    expect(sizeText({ size_bytes: null, estimate: 'exact' })).toBe('tamaño desconocido')
    expect(sizeText({ size_bytes: 5, estimate: 'unknown' })).toBe('tamaño desconocido')
    expect(sizeText({ size_bytes: 2048, estimate: 'upper_bound' })).toMatch(/^≤ .*\(aprox\.\)$/)
  })
})

describe('Construir imagen (BuildPage)', () => {
  const fill = async (u: ReturnType<typeof userEvent.setup>, ctx = '/home/u/app', tag = 'mi-app:1') => {
    await u.type(await screen.findByLabelText('Directorio de contexto'), ctx)
    if (tag) await u.type(screen.getByLabelText(/Etiqueta de la imagen/), tag)
  }
  it('valida en el borde: contexto relativo, Dockerfile con «..», etiqueta en mayúsculas y ARG sin nombre', async () => {
    const u = userEvent.setup()
    renderView(<BuildPage />, { hash: '#build' })
    await u.click(await screen.findByRole('button', { name: 'Construir' }))
    expect(await screen.findByText('Indica la ruta ABSOLUTA del directorio de contexto.')).toBeInTheDocument()
    await fill(u, '/ok', 'MAYUS:1')
    await u.type(screen.getByLabelText(/^Dockerfile/), '../x')
    await u.click(screen.getByRole('button', { name: 'Añadir argumento' }))
    await u.type(screen.getByLabelText('Valor del argumento 1'), 'v')
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    expect(await screen.findByText(/sin «\.\.»/)).toBeInTheDocument()
    expect(screen.getByText(/minúsculas/)).toBeInTheDocument()
    expect(screen.getByText(/nombre válido/)).toBeInTheDocument()
  })
  it('construye: pasos, líneas crudas, imagen nueva en Imágenes y aviso; el valor del ARG no se muestra en la salida', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<BuildPage />, { hash: '#build' })
    await fill(u)
    await u.click(screen.getByRole('button', { name: 'Añadir argumento' }))
    await u.type(screen.getByLabelText('Nombre del argumento 1'), 'API_TOKEN')
    await u.type(screen.getByLabelText('Valor del argumento 1'), 'valor-secreto-123')
    expect(screen.getByText('Un argumento parece un secreto')).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    expect(await screen.findByRole('region', { name: 'Progreso de la construcción' })).toBeInTheDocument()
    expect(await screen.findByText('Construcción terminada', undefined, { timeout: 6000 })).toBeInTheDocument()
    expect(screen.getAllByText('Imagen construida').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('valor-secreto-123')
    expect(api.sim.world.images.some((i) => i.reference === 'mi-app:1')).toBe(true)
  })
  it('contexto sensible: pide confirmación con los avisos; «Revisar» no construye', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<BuildPage />, { hash: '#build' })
    await fill(u, '/home/u')
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText('Confirmar construcción con contexto sensible')).toBeInTheDocument()
    expect(within(dlg).getByText(/ruta sensible/)).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Revisar' }))
    expect(screen.queryByRole('region', { name: 'Progreso de la construcción' })).toBeNull()
    expect(api.sim.world.images.some((i) => i.reference === 'mi-app:1')).toBe(false)
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Construir igualmente' }))
    expect(await screen.findByText('Construcción terminada', undefined, { timeout: 6000 })).toBeInTheDocument()
  })
  it('un fallo de construcción muestra el error; cancelar detiene y lo dice', async () => {
    const u = userEvent.setup()
    const { unmount } = renderView(<BuildPage />, { hash: '#build' })
    await fill(u, '/home/u/app-fail', '')
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    expect(await screen.findByText('No se pudo construir la imagen', undefined, { timeout: 6000 })).toBeInTheDocument()
    expect(screen.getByText(/non-zero code/)).toBeInTheDocument()
    unmount()
    renderView(<BuildPage />, { hash: '#build' })
    await fill(u)
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    await u.click(await screen.findByRole('button', { name: 'Cancelar construcción' }))
    expect((await screen.findAllByText('Construcción cancelada')).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Construir de nuevo' })).toBeInTheDocument()
  })
  it('salir de la vista cancela la construcción en curso (no deja el canal abierto)', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    let cancelled = 0
    const orig = api.images.build
    api.images.build = (s, t, on) => { const off = orig(s, t, on); return () => { cancelled++; off() } }
    const { unmount } = renderView(<BuildPage />, { api, hash: '#build' })
    await fill(u)
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    await screen.findByRole('button', { name: 'Cancelar construcción' })
    unmount()
    expect(cancelled).toBe(1)
  })
})

describe('Avisos de seguridad de construcción: texto', () => {
  it('warningText de un tipo desconocido muestra su nombre como texto', async () => {
    const { warningText } = await import('./images/buildWarnings')
    expect(warningText({ type: '<x>' })).toContain('<x>')
    expect(warningText({ type: 'secret_like_arg', name: 'DB_PASSWORD' })).toMatch(/DB_PASSWORD.*secreto/)
  })
})

describe('Limpieza y cambio de conexión', () => {
  it('al cambiar de conexión el informe anterior se descarta y se pide el de la nueva (no se limpia con la lista de otro equipo)', async () => {
    const api = makeApi()
    const orig = api.system.cleanupReport
    let mode: 'normal' | 'slow' = 'normal'
    api.system.cleanupReport = async (o) => { const r = await orig(o); if (mode === 'slow') await new Promise((res) => setTimeout(res, 150)); return r }
    const spy = vi.spyOn(api.system, 'cleanupReport')
    const stores: { getState(): { selectProfile(id: string): Promise<void> } }[] = []
    function Grab() { const st = useEngineStoreApi(); useEffect(() => { stores.push(st) }, [st]); return null }
    renderView(<><CleanupPage /><Grab /></>, { api, hash: '#cleanup' })
    await screen.findByRole('region', { name: 'Volúmenes sin usar' }, { timeout: 3000 })
    const before = spy.mock.calls.length
    mode = 'slow'
    await act(async () => { await stores[0].getState().selectProfile('prod') })
    // Mientras llega el informe de la nueva conexión NO se muestra el anterior.
    expect(screen.queryByRole('region', { name: 'Volúmenes sin usar' })).toBeNull()
    await screen.findByRole('region', { name: 'Volúmenes sin usar' }, { timeout: 3000 })
    expect(spy.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('B-6: aviso de conexión remota solo en acciones remotas', () => {
  it('stack_delete (archivos locales) no dice que se ejecuta en el equipo remoto; remove_containers sí', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    await api.connections.select('prod')
    api.sim.world.ownStacks.push({ name: 'mio', origin: 'managed', path: '/x', yaml: 'services: {}', env: '', revision: 1 })
    const { useGuardedAction } = await import('@/components/shared/useGuardedAction')
    let guard: ReturnType<typeof useGuardedAction> | null = null
    let st: ReturnType<typeof useEngineStoreApi> | null = null
    function Grab() { const g = useGuardedAction(); const e = useEngineStoreApi(); useEffect(() => { guard = g; st = e }); return null }
    renderView(<Grab />, { api })
    await waitFor(() => expect(st!.getState().connection.status).toBe('connected'))
    await act(async () => { void guard!({ type: 'stack_delete', name: 'mio' }) })
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).queryByText(/Conexión remota/)).toBeNull()
    await u.click(within(dlg).getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const c = api.sim.world.containers.find((x) => x.state === 'exited')!
    await act(async () => { void guard!({ type: 'remove_containers', ids: [c.id] }) })
    expect(await within(await screen.findByRole('alertdialog')).findByText(/Conexión remota/)).toBeInTheDocument()
  })
})

describe('revisión fase 4: Nueva conexión', () => {
  const fill = async (u: ReturnType<typeof userEvent.setup>, host: string, name = 'nuevo-e2e') => {
    await u.type(await screen.findByLabelText('Nombre'), name)
    await u.type(screen.getByLabelText(/^Host/), host)
    await u.type(screen.getByLabelText('Usuario'), 'deploy')
  }
  it('M-2: un nombre ya usado se rechaza en el formulario (sin sondear) y un Conflict del backend se muestra en el campo', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<ConnNewPage />, { hash: '#conn-new' })
    const probe = vi.spyOn(api.connections, 'probeHostKey')
    await screen.findByLabelText('Nombre')
    await waitFor(async () => expect((await api.connections.list()).length).toBeGreaterThan(1))
    await fill(u, '203.0.113.9', 'PROD-hetzner')
    await u.click(screen.getByRole('button', { name: 'Verificar y probar' }))
    expect(await screen.findByText(/Ya existe una conexión con ese nombre/)).toBeInTheDocument()
    expect(probe).not.toHaveBeenCalled()
  })
  it('M-2: si el backend devuelve conflict al guardar, el error va al campo Nombre y se enfoca', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<ConnNewPage />, { hash: '#conn-new' })
    api.connections.save = async () => { throw { code: 'conflict', message: 'nombre en uso' } }
    await fill(u, '203.0.113.9')
    await u.click(screen.getByRole('button', { name: 'Verificar y probar' }))
    await u.click(await within(await screen.findByRole('alertdialog', undefined, { timeout: 3000 })).findByRole('button', { name: 'Confiar y continuar' }))
    await screen.findByText('Conexión correcta', undefined, { timeout: 4000 })
    await u.click(screen.getByRole('button', { name: 'Guardar conexión' }))
    expect(await screen.findByText(/Ya existe una conexión con ese nombre: elige otro\./)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Nombre')).toHaveFocus())
  })
  it('M-6: «Verificar y probar» no se deshabilita (aria-disabled) y el foco vuelve al botón al cerrar el diálogo (unknown y changed)', async () => {
    const u = userEvent.setup()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await fill(u, 'changed-host')
    const btn = screen.getByRole('button', { name: 'Verificar y probar' })
    await u.click(btn)
    const dlg = await screen.findByRole('alertdialog', undefined, { timeout: 3000 })
    expect(btn).not.toBeDisabled()
    await u.click(within(dlg).getByRole('button', { name: 'Cerrar' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(btn).toHaveFocus())
    // B-1: el bloqueo por clave cambiada queda escrito en la página al cerrar el diálogo.
    expect(screen.getByText('La clave del host cambió: conexión bloqueada')).toBeInTheDocument()
    await u.clear(screen.getByLabelText(/^Host/))
    await u.type(screen.getByLabelText(/^Host/), 'srv.ok')
    await u.click(btn)
    const dlg2 = await screen.findByRole('alertdialog', undefined, { timeout: 3000 })
    await u.click(within(dlg2).getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(btn).toHaveFocus())
  })
  it('B-1: un fallo de trustHostKey muestra su causa real, no «la clave cambió»', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<ConnNewPage />, { hash: '#conn-new' })
    api.connections.trustHostKey = async () => { throw { code: 'conflict', message: 'la huella del servidor cambió desde que la viste: vuelve a sondear' } }
    await fill(u, 'srv.b1')
    await u.click(screen.getByRole('button', { name: 'Verificar y probar' }))
    await u.click(await within(await screen.findByRole('alertdialog', undefined, { timeout: 3000 })).findByRole('button', { name: 'Confiar y continuar' }))
    expect(await screen.findByText('No se pudo conectar')).toBeInTheDocument()
    expect(screen.queryByText(/clave del host cambió: conexión bloqueada/)).toBeNull()
    expect(screen.getByText(/vuelve a sondear/)).toBeInTheDocument()
  })
})

describe('revisión fase 4: Construir imagen', () => {
  it('M-4: el texto dice que la ruta es LOCAL; con conexión remota avisa que el contenido va al servidor (y en el diálogo de contexto sensible)', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    await api.connections.select('prod')
    renderView(<BuildPage />, { api, hash: '#build' })
    await screen.findByLabelText('Directorio de contexto')
    expect(screen.getByText(/corre aquí y sube el contenido/)).toBeInTheDocument()
    expect(screen.getByText(/El contenido de esta carpeta se enviará al servidor/)).toHaveTextContent('prod-hetzner')
    await u.type(screen.getByLabelText('Directorio de contexto'), '/home/u')
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    expect(await within(await screen.findByRole('alertdialog')).findByText(/al servidor/)).toHaveTextContent('prod-hetzner')
  })
  it('M-4: en local no hay aviso de servidor', async () => {
    renderView(<BuildPage />, { hash: '#build' })
    await screen.findByLabelText('Directorio de contexto')
    expect(screen.queryByText(/se enviará al servidor/)).toBeNull()
  })
  it('M-5: navegar fuera con una construcción en curso pide confirmar; «Seguir construyendo» se queda y «Cancelar y salir» cancela', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    let cancelled = 0
    api.images.build = (_spec, _ticket, on) => {
      on({ type: 'step', n: 2, total: 6 })
      on({ type: 'line', text: 'RUN paso-en-curso', stream: 'stdout' })
      return () => { cancelled++ }
    } // una construcción que no termina
    renderView(<BuildPage />, { api, hash: '#build' })
    await u.type(await screen.findByLabelText('Directorio de contexto'), '/home/u/app')
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    await screen.findByRole('button', { name: 'Cancelar construcción' })
    act(() => { window.location.hash = '#images' })
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByRole('heading', { name: 'Hay una construcción en curso' })).toBeInTheDocument()
    await u.click(within(dlg).getByRole('button', { name: 'Seguir construyendo' }))
    await waitFor(() => expect(window.location.hash).toBe('#build'))
    expect(cancelled).toBe(0)
    expect(await screen.findByText('RUN paso-en-curso')).toBeInTheDocument()
    act(() => { window.location.hash = '#images' })
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar y salir' }))
    await waitFor(() => expect(window.location.hash).toBe('#images'))
  })
  it('B-11: los valores de ARG con nombre tipo secreto son password y el texto documenta que van por entorno', async () => {
    const u = userEvent.setup()
    renderView(<BuildPage />, { hash: '#build' })
    await u.click(await screen.findByRole('button', { name: 'Añadir argumento' }))
    const v = screen.getByLabelText('Valor del argumento 1')
    expect(v).toHaveAttribute('type', 'text')
    await u.type(screen.getByLabelText('Nombre del argumento 1'), 'DB_PASSWORD')
    expect(v).toHaveAttribute('type', 'password')
    await u.clear(screen.getByLabelText('Nombre del argumento 1'))
    await u.type(screen.getByLabelText('Nombre del argumento 1'), 'NODE_ENV')
    expect(v).toHaveAttribute('type', 'text')
    expect(screen.getByText(/variable de entorno del proceso/)).toBeInTheDocument()
  })
})

describe('revisión fase 4: Limpieza', () => {
  const okName = (n: string) => n
  it('B-5: el tope de 500 bloquea «Revisar y limpiar» con aviso; defaults_truncated se explica', async () => {
    const api = makeApi()
    for (let i = 0; i < 505; i++) api.sim.world.networks.push({ id: `n${i}`.padEnd(64, '0'), name: okName(`red-${i}`), driver: 'bridge', scope: 'local', subnets: [], internal: false, system: false, connected: [], compose_project: null })
    const orig = api.system.cleanupReport
    api.system.cleanupReport = async (o) => ({ ...(await orig(o)), defaults_truncated: true })
    renderView(<CleanupPage />, { api, hash: '#cleanup' })
    expect(await screen.findByText(/Hay más de 500 elementos recomendados/, undefined, { timeout: 4000 })).toBeInTheDocument()
    expect(await screen.findByText('Máximo 500 elementos por limpieza')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Resumen de la selección' })).getByRole('button', { name: 'Revisar y limpiar' })).toHaveAttribute('aria-disabled', 'true')
  })
  it('B-5: un conflict al ejecutar vuelve a pedir el informe', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    const spy = vi.spyOn(api.system, 'cleanupReport')
    api.actions.execute = async () => { throw { code: 'conflict', message: 'cambió' } }
    renderView(<CleanupPage />, { api, hash: '#cleanup' })
    await screen.findByRole('region', { name: 'Volúmenes sin usar' }, { timeout: 3000 })
    const n = spy.mock.calls.length
    await u.click(within(screen.getByRole('region', { name: 'Resumen de la selección' })).getByRole('button', { name: 'Revisar y limpiar' }))
    await u.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /Eliminar \d+ elementos/ }))
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(n))
  })
  it('skipped: la confirmación muestra los elementos omitidos por el plan', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    const orig = api.actions.plan
    api.actions.plan = async (r) => { const p = await orig(r); return { ...p, warnings: [...p.warnings, { type: 'skipped', items: ['viejo-1', '<b>x</b>'] }] } }
    renderView(<CleanupPage />, { api, hash: '#cleanup' })
    await screen.findByRole('region', { name: 'Volúmenes sin usar' }, { timeout: 3000 })
    await u.click(within(screen.getByRole('region', { name: 'Resumen de la selección' })).getByRole('button', { name: 'Revisar y limpiar' }))
    const dlg = await screen.findByRole('alertdialog')
    expect(within(dlg).getByText(/Se omiten 2 elemento/)).toHaveTextContent('viejo-1')
    expect(dlg.querySelector('b')?.textContent).not.toBe('x')
  })
  it('B-12: aria-controls solo con la categoría abierta; el resumen visible no es aria-live y hay UN estado polite', async () => {
    const u = userEvent.setup()
    renderView(<CleanupPage />, { hash: '#cleanup' })
    const toggle = await screen.findByRole('button', { name: /Contenedores detenidos/ }, { timeout: 3000 })
    expect(toggle).toHaveAttribute('aria-controls', 'cat-stopped_containers')
    expect(document.getElementById('cat-stopped_containers')).not.toBeNull()
    await u.click(toggle)
    expect(toggle).not.toHaveAttribute('aria-controls')
    const bar = screen.getByRole('region', { name: 'Resumen de la selección' })
    expect(bar.querySelectorAll('[aria-live]')).toHaveLength(1)
    expect(bar.querySelector('.cleanup-sum')).not.toHaveAttribute('aria-live')
    expect(bar.querySelector('[role=status]')).toHaveClass('sr-only')
  })
})

describe('revisión fase 4: ARG reservados', () => {
  it('nombres reservados se rechazan en la UI y en el simulado', async () => {
    const u = userEvent.setup()
    const { api } = renderView(<BuildPage />, { hash: '#build' })
    await u.type(await screen.findByLabelText('Directorio de contexto'), '/home/u/app')
    await u.click(screen.getByRole('button', { name: 'Añadir argumento' }))
    await u.type(screen.getByLabelText('Nombre del argumento 1'), 'HTTP_PROXY')
    await u.click(screen.getByRole('button', { name: 'Construir' }))
    expect(await screen.findByText(/está reservado/)).toBeInTheDocument()
    await expect(api.images.planBuild({ context_dir: '/a', dockerfile: null, tag: null, build_args: [['LD_PRELOAD', 'x']], target: null, no_cache: false, pull: false })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('B-8: muestras obsoletas atenuadas', () => {
  it('la franja y las filas se atenúan mientras statsStale y vuelven al llegar la muestra', async () => {
    const stores: ReturnType<typeof useEngineStoreApi>[] = []
    function Grab() { const s = useEngineStoreApi(); useEffect(() => { stores.push(s) }, [s]); return null }
    renderView(<><ContainersPage /><Grab /></>)
    await screen.findByRole('link', { name: 'tienda-api-1' })
    await waitFor(() => expect(document.querySelector('.resource-strip')).not.toBeNull())
    expect(document.querySelector('.resource-strip.is-stale')).toBeNull()
    act(() => stores[0].setState({ statsStale: true }))
    expect(document.querySelector('.resource-strip.is-stale')).not.toBeNull()
    expect(document.querySelectorAll('td.col-cpu.is-stale').length).toBeGreaterThan(0)
    act(() => stores[0].setState({ statsStale: false }))
    expect(document.querySelector('.resource-strip.is-stale')).toBeNull()
  })
})

describe('fase 6: F1 cancelar construcción y F2 foco al primer inválido', () => {
  it('F1: «Cancelar construcción» NO dispara submit ni arranca otro build (regresión: el nodo del botón se reutilizaba como type=submit)', async () => {
    const api = makeApi()
    let starts = 0
    let cancels = 0
    api.images.build = () => { starts++; return () => { cancels++ } }
    renderView(<BuildPage />, { api, hash: '#build' })
    fireEvent.change(await screen.findByLabelText('Directorio de contexto'), { target: { value: '/home/u/app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Construir' }))
    const cancel = await screen.findByRole('button', { name: 'Cancelar construcción' })
    const form = cancel.closest('form')!
    const submits = vi.fn()
    form.addEventListener('submit', submits)
    fireEvent.click(cancel)
    await screen.findByRole('button', { name: 'Construir de nuevo' })
    await new Promise((r) => setTimeout(r, 30))
    expect(submits).not.toHaveBeenCalled()
    expect(starts).toBe(1)
    expect(cancels).toBe(1)
    // El botón de cancelar y el de construir son nodos DISTINTOS.
    expect(screen.queryByRole('button', { name: 'Cancelar construcción' })).toBeNull()
  })
  it('F2: el primer intento inválido ya enfoca el primer campo con aria-invalid (Construir y Nueva conexión)', async () => {
    const u = userEvent.setup()
    const { unmount } = renderView(<BuildPage />, { hash: '#build' })
    await u.click(await screen.findByRole('button', { name: 'Construir' }))
    await waitFor(() => expect(screen.getByLabelText('Directorio de contexto')).toHaveFocus())
    unmount()
    renderView(<ConnNewPage />, { hash: '#conn-new' })
    await u.click(await screen.findByRole('button', { name: 'Verificar y probar' }))
    await waitFor(() => expect(screen.getByLabelText('Nombre')).toHaveFocus())
  })
})
