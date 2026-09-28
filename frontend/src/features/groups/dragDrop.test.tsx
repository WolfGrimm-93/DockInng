// Arrastrar filas a un grupo (jsdom: no hay layout real; `elementFromPoint` se sustituye por un stub y los eventos de puntero se disparan a mano).
import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContainersPage from '../containers/ContainersPage'
import { makeApi, renderView, resetGlobals } from '../testUtils'
import { resetDragStore, useDragStore } from './dragStore'
import { assignKey, useGroupsStore } from './groupsStore'
import { dropOutcome } from './useRowDrag'

let target: Element | null = null
beforeEach(() => {
  target = null
  document.elementFromPoint = () => target
})
afterEach(() => { resetGlobals(); resetDragStore(); document.body.classList.remove('is-row-dragging') })

const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement
const grip = (name: string) => screen.getByRole('button', { name: `Arrastrar ${name} a un grupo` })
const move = (x: number, y: number) => fireEvent(window, new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
const up = (x = 100, y = 100) => fireEvent(window, new MouseEvent('pointerup', { clientX: x, clientY: y, bubbles: true }))
const down = (el: Element, x = 10, y = 10) => fireEvent(el, Object.assign(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }), { isPrimary: true }))
const profile = 'local'
const at = (name: string) => useGroupsStore.getState().assign[assignKey(profile, name)]

async function setup() {
  const api = makeApi()
  const view = renderView(<ContainersPage />, { api })
  await screen.findByRole('link', { name: 'tienda-api-1' })
  const gid = useGroupsStore.getState().createGroup('Favoritos', 200) as string
  const empty = useGroupsStore.getState().createGroup('Vacío', 40) as string
  return { ...view, gid, empty }
}

describe('arrastrar filas a un grupo', () => {
  it('el asa tiene nombre accesible y describedby con la alternativa; no es una parada de tabulación', async () => {
    await setup()
    const g = grip('minio-dev')
    expect(g).toHaveAttribute('tabindex', '-1')
    expect(document.getElementById(g.getAttribute('aria-describedby') as string)?.textContent).toMatch(/Mover a un grupo/)
    // La alternativa por menú sigue en cada fila.
    expect(screen.getByRole('button', { name: 'Mover minio-dev a un grupo' })).toBeInTheDocument()
  })

  it('una fila: umbral de 5 px, bandeja con «Sin grupo» y cada grupo (también los vacíos), soltar sobre un chip mueve', async () => {
    const { gid, empty } = await setup()
    const rowsBefore = screen.getByRole('table').getAttribute('aria-rowcount')
    down(grip('minio-dev'))
    move(12, 12) // < 5 px: aún no arrastra
    expect(useDragStore.getState().ids).toHaveLength(0)
    expect(document.querySelector('[data-drag-tray]')).toBeNull()
    move(40, 40)
    expect(useDragStore.getState().names).toEqual(['minio-dev'])
    expect(rowOf('minio-dev')).toHaveClass('is-dragging')
    const tray = document.querySelector('[data-drag-tray]') as HTMLElement
    expect(tray).toHaveAttribute('aria-hidden', 'true')
    expect(tray.querySelectorAll('[data-drop-key]')).toHaveLength(3) // Sin grupo + 2 grupos propios
    expect(tray.querySelector(`[data-drop-key="g:${empty}"]`)).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Arrastrando 1 contenedor')
    // aria-rowcount no cambia durante el arrastre.
    expect(screen.getByRole('table').getAttribute('aria-rowcount')).toBe(rowsBefore)
    target = tray.querySelector(`[data-drop-key="g:${gid}"]`)
    move(50, 50)
    expect(target).toHaveAttribute('data-drop', 'over')
    up(50, 50)
    expect(at('minio-dev')).toBe(gid)
    expect(useDragStore.getState().ids).toHaveLength(0)
    expect(document.querySelector('[data-drag-tray]')).toBeNull()
    expect(document.body).not.toHaveClass('is-row-dragging')
    expect(await screen.findByText(/1 contenedor movido a «Favoritos»/)).toBeInTheDocument()
  })

  it('un clic simple sin movimiento no arrastra ni mueve nada', async () => {
    await setup()
    down(grip('minio-dev'))
    up()
    expect(useDragStore.getState().ids).toHaveLength(0)
    expect(at('minio-dev')).toBeUndefined()
  })

  it('selección múltiple: arrastrar una fila seleccionada mueve TODAS las seleccionadas; una no seleccionada mueve solo ella', async () => {
    const u = userEvent.setup()
    const { gid } = await setup()
    await u.click(screen.getByRole('checkbox', { name: 'Seleccionar minio-dev' }))
    await u.click(screen.getByRole('checkbox', { name: 'Seleccionar tienda-redis-1' }))
    down(grip('minio-dev'))
    move(60, 60)
    expect([...useDragStore.getState().names].sort()).toEqual(['minio-dev', 'tienda-redis-1'])
    expect(screen.getByRole('status')).toHaveTextContent('Arrastrando 2 contenedores')
    target = document.querySelector(`[data-drop-key="g:${gid}"]`)
    up(60, 60)
    expect(at('minio-dev')).toBe(gid)
    expect(at('tienda-redis-1')).toBe(gid)
    // Fila NO seleccionada: solo ella.
    down(grip('tienda-web-1'))
    move(80, 80)
    expect(useDragStore.getState().names).toEqual(['tienda-web-1'])
    target = document.querySelector('[data-drop-key="none"]')
    up(80, 80)
    expect(at('tienda-web-1')).toBeUndefined()
  })

  it('«Sin grupo» saca a los contenedores de su grupo propio', async () => {
    const { gid } = await setup()
    useGroupsStore.getState().moveContainers(profile, ['minio-dev'], gid)
    await screen.findByRole('link', { name: 'minio-dev' })
    down(grip('minio-dev'))
    move(60, 60)
    target = document.querySelector('[data-drop-key="none"]')
    up(60, 60)
    expect(at('minio-dev')).toBeUndefined()
  })

  it('soltar sobre la cabecera de un stack (s:) no mueve y avisa; la cabecera lleva data-drop-key', async () => {
    await setup()
    const stackRow = document.querySelector('tr.group-row[data-drop-key^="s:"]') as HTMLElement
    expect(stackRow).not.toBeNull()
    expect(stackRow).toHaveAttribute('data-group-kind', 'stack')
    down(grip('minio-dev'))
    move(60, 60)
    target = stackRow
    move(61, 61)
    expect(stackRow).toHaveAttribute('data-drop', 'deny')
    up(61, 61)
    expect(at('minio-dev')).toBeUndefined()
    expect(stackRow).not.toHaveAttribute('data-drop')
    expect(await screen.findByText(/stack de Compose es automático/)).toBeInTheDocument()
  })

  it('Escape cancela el arrastre sin mover nada; soltar fuera de un destino tampoco mueve', async () => {
    const { gid } = await setup()
    down(grip('minio-dev'))
    move(60, 60)
    target = document.querySelector(`[data-drop-key="g:${gid}"]`)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useDragStore.getState().ids).toHaveLength(0)
    up(60, 60)
    expect(at('minio-dev')).toBeUndefined()
    down(grip('minio-dev'))
    move(60, 60)
    target = null
    up(60, 60)
    expect(at('minio-dev')).toBeUndefined()
    expect(document.querySelector('[data-drag-tray]')).toBeNull()
  })

  it('el botón secundario no inicia el arrastre; desmontar en pleno arrastre limpia la bandeja y el cursor', async () => {
    const { unmount } = await setup()
    fireEvent(grip('minio-dev'), Object.assign(new MouseEvent('pointerdown', { clientX: 0, clientY: 0, button: 2, bubbles: true }), { isPrimary: true }))
    move(90, 90)
    expect(useDragStore.getState().ids).toHaveLength(0)
    down(grip('minio-dev'))
    move(60, 60)
    expect(document.body).toHaveClass('is-row-dragging')
    act(() => { unmount() })
    expect(document.body).not.toHaveClass('is-row-dragging')
    expect(document.querySelector('[data-drag-tray]')).toBeNull()
  })
})

describe('dropOutcome (pura)', () => {
  const groups = [{ id: 'a', name: 'A' }]
  it('stack denegado, grupo inexistente denegado, mismo grupo no-op, «none» sin asignaciones no-op', () => {
    expect(dropOutcome('s:tienda', ['x'], 'local', groups, {}).kind).toBe('deny')
    expect(dropOutcome('g:zzz', ['x'], 'local', groups, {}).kind).toBe('deny')
    expect(dropOutcome('g:a', ['x'], 'local', groups, { [assignKey('local', 'x')]: 'a' }).kind).toBe('noop')
    expect(dropOutcome('none', ['x'], 'local', groups, {}).kind).toBe('noop')
    expect(dropOutcome('g:a', ['x'], 'local', groups, {})).toEqual({ kind: 'move', groupId: 'a', label: 'A' })
    expect(dropOutcome('none', ['x'], 'local', groups, { [assignKey('local', 'x')]: 'a' })).toEqual({ kind: 'move', groupId: null, label: 'Sin grupo' })
  })
})

vi.setConfig({ testTimeout: 15000 })
