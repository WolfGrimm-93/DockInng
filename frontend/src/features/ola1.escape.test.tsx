// Escape de contenido no confiable (nombres de Docker, salida de compose, mensajes de error) en las pantallas de la Ola 1.
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEngineStoreApi } from '@/data/store/hooks'
import CreateContainerPage from './containers/CreateContainerPage'
import PullPage from './images/PullPage'
import StacksPage from './stacks/StacksPage'
import { useGroupsStore } from './groups/groupsStore'
import { makeApi, renderView, resetGlobals } from './testUtils'

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
afterEach(resetGlobals)

const EVIL = '<img src=x onerror=alert(1)>'

describe('escape XSS en la Ola 1', () => {
  it('salida de docker compose, nombre de servicio y mensaje de error del stack se pintan como texto', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    api.sim.world.containers[0].compose_service = EVIL
    const stores: ReturnType<typeof useEngineStoreApi>[] = []
    function Grab() { const st = useEngineStoreApi(); useEffect(() => { stores.push(st) }, [st]); return null }
    renderView(<><StacksPage /><Grab /></>, { api })
    await screen.findByRole('region', { name: 'Stack tienda' })
    act(() => {
      stores[0].setState({ stackOps: { tienda: { kind: 'up', state: 'error', services: [{ name: EVIL, percent: 30, phase: 'pulling' }], log: [EVIL, `Error: ${EVIL}`], error: { code: 'compose_failed', message: EVIL }, issues: [{ line: 3, column: null, kind: 'syntax', message: EVIL }], startedAt: 0 } } })
    })
    await u.click(await screen.findByText('Salida de docker compose'))
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getAllByText(EVIL, { exact: false }).length).toBeGreaterThan(0)
  })

  it('crear: imágenes locales y grupos con HTML en el nombre no crean elementos', async () => {
    const api = makeApi()
    api.sim.world.images[0].reference = EVIL + ':1'
    useGroupsStore.getState().createGroup('<b>grupo</b>', 10)
    renderView(<CreateContainerPage />, { api, hash: '#create' })
    await screen.findByLabelText(/^Grupo propio/)
    expect(document.querySelector('img, b')).toBeNull()
    expect(screen.getByRole('option', { name: '<b>grupo</b>' })).toBeInTheDocument()
  })

  it('pull: el mensaje de error del registro se pinta como texto', async () => {
    const u = userEvent.setup()
    const api = makeApi()
    api.images.pull = (_ref, on) => {
      setTimeout(() => on({ type: 'ended', outcome: 'error', up_to_date: false, digest: null, error: { code: 'engine', message: EVIL } }), 0)
      return () => {}
    }
    renderView(<PullPage />, { api, hash: '#pull?image=x/y:1' })
    await u.click(await screen.findByRole('button', { name: 'Descargar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument())
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getAllByText(EVIL, { exact: false }).length).toBeGreaterThan(0)
  })

  it('terminal (pestaña sin sesión): un nombre de contenedor malicioso se pinta como texto', async () => {
    const { default: ContainerDetailPage } = await import('./containers/ContainerDetailPage')
    const api = makeApi()
    api.sim.world.containers[0].names = [EVIL]
    api.sim.world.containers[0].state = 'exited' // parado: no monta xterm (jsdom); el nombre igualmente aparece en la cabecera y el panel
    renderView(<ContainerDetailPage />, { api, hash: `#detail?c=${encodeURIComponent(EVIL)}&tab=terminal` })
    await screen.findByRole('tab', { name: 'Terminal' })
    expect(document.querySelector('img')).toBeNull()
  })
})
