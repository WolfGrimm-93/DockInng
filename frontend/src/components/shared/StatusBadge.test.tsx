import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Providers } from '@/app/providers'
import { AppShell } from '@/app/AppShell'
import { useUiStore } from '@/app/uiStore'
import { createSimApi } from '@/data/adapters/sim'
import type { ContainerState } from '@/data/types'
import { PageHeader } from './PageHeader'
import { STATUS_UI, StatusBadge, toUiStatus } from './StatusBadge'

describe('StatusBadge', () => {
  const cases: [ContainerState, string, string][] = [
    ['running', 'En ejecución', 'status-running'], ['paused', 'Pausado', 'status-paused'], ['restarting', 'Reiniciando', 'status-restarting'],
    ['exited', 'Detenido', 'status-exited'], ['dead', 'Muerto', 'status-dead'], ['created', 'Creado', 'status-created'],
  ]
  it.each(cases)('%s: icono + texto «%s»', (state, label, cls) => {
    const { container } = render(<StatusBadge state={state} />)
    const el = screen.getByText(label)
    expect(el).toHaveClass('status', cls)
    expect(container.querySelector('svg')).not.toBeNull() // el icono es obligatorio (no solo color)
  })
  it('las 6 formas son distintas (legible en escala de grises); ▶ no se usa para «En ejecución»', () => {
    const icons = Object.values(STATUS_UI).map((d) => d.icon)
    expect(new Set(icons).size).toBe(6)
    expect(STATUS_UI.running.icon).toBe('dot')
    expect(icons).not.toContain('play')
  })
  it('busy sustituye por spinner y etiqueta de acción en curso', () => {
    const { rerender, container } = render(<StatusBadge state="running" busy="start" />)
    expect(screen.getByText('Iniciando…')).toBeInTheDocument()
    expect(container.querySelector('svg.spin')).not.toBeNull()
    rerender(<StatusBadge state="running" busy="remove" />)
    expect(screen.getByText('Eliminando…')).toBeInTheDocument()
    rerender(<StatusBadge state="removing" />)
    expect(screen.getByText('Eliminando…')).toBeInTheDocument()
  })
  it('unknown se muestra como «Desconocido» con aspecto exited', () => {
    render(<StatusBadge state="unknown" />)
    expect(screen.getByText('Desconocido')).toHaveClass('status-exited')
    expect(toUiStatus('unknown')).toBe('exited')
  })
})

describe('PageHeader', () => {
  it('título en h1#viewTitle enfocable, contador, acciones y «volver»', () => {
    render(<PageHeader title="Volúmenes" count="7 · 11 GB" back={{ href: '#containers', label: 'Contenedores' }} secondary={<button>Sec</button>} primary={<button>Pri</button>} simulated />)
    const h1 = screen.getByRole('heading', { level: 1, name: 'Volúmenes' })
    expect(h1).toHaveAttribute('id', 'viewTitle')
    expect(h1).toHaveAttribute('tabindex', '-1')
    expect(screen.getByText('7 · 11 GB')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Contenedores' })).toHaveAttribute('href', '#containers')
    expect(screen.getByText('No conectado aún')).toBeInTheDocument()
  })
})

describe('tooltips del riel', () => {
  it('con la barra colapsada, pasar el ratón por un ítem muestra su nombre; expandida no hay tooltip', async () => {
    const u = userEvent.setup()
    useUiStore.setState({ collapsed: true })
    document.documentElement.classList.add('is-collapsed')
    render(<Providers api={createSimApi({ latency: 0 })}><AppShell /></Providers>)
    await u.hover(screen.getByRole('link', { name: 'Volúmenes' }))
    expect(await screen.findByText('Volúmenes', { selector: '.tip' })).toBeInTheDocument()
    document.documentElement.classList.remove('is-collapsed')
    useUiStore.setState({ collapsed: false })
  })
})

describe('StatusBadge: indicadores animados solo en el detalle', () => {
  it('«en ejecución» y «reiniciando» llevan is-live solo con la prop live (detalle); en filas no', async () => {
    const { render } = await import('@testing-library/react')
    const { StatusBadge } = await import('./StatusBadge')
    const a = render(<StatusBadge state="restarting" />)
    expect(a.container.querySelector('.is-live')).toBeNull()
    a.unmount()
    const b = render(<StatusBadge state="restarting" live />)
    expect(b.container.querySelector('.status-restarting.is-live')).not.toBeNull()
    expect(b.container).toHaveTextContent('Reiniciando') // el texto y el icono se conservan (accesibilidad)
    b.unmount()
    const c = render(<StatusBadge state="running" live />)
    expect(c.container.querySelector('.status-running.is-live')).not.toBeNull()
    expect(c.container.querySelector('svg')).not.toBeNull()
  })
})
