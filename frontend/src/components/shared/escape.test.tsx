// Seguridad (XSS): los datos de Docker son texto NO confiable. Nada debe crear elementos HTML ni ejecutar código.
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createSimApi } from '@/data/adapters/sim'
import { EngineProvider } from '@/data/EngineProvider'
import type { ActionPlan } from '@/data/types'
import { useContainers } from '@/data/store/hooks'
import { containerName } from '@/data/store/engineStore'
import { tokenizeJson } from '@/lib/json'
import { DialogList } from './DialogList'
import { LogViewer } from './LogViewer'
import { describePlan } from './planDescribe'
import { PageHeader } from './PageHeader'

const EVIL = 'x"><img src=x onerror=alert(1)><script>alert(2)</script>'

function NamesList() {
  const { list } = useContainers()
  return <ul>{list.map((c) => <li key={c.id}>{containerName(c)}</li>)}</ul>
}

describe('escape de nombres maliciosos', () => {
  it('DialogList y describePlan pintan el nombre como texto', () => {
    const plan: ActionPlan = {
      decision: { type: 'confirm' }, ticket: 't', expires_in_secs: 120, total_size_bytes: null,
      affected: [{ kind: 'container', id: '1', name: EVIL, state: 'running' }, { kind: 'container', id: '2', name: 'ok', state: 'exited' }],
      warnings: [{ type: 'volumes_kept', items: [EVIL] }, { type: 'bind_mounts_kept', items: [EVIL] }],
    }
    const d = describePlan(plan, { type: 'remove_containers', ids: ['1', '2'] })
    const { container } = render(<div>{d.description}{d.extra}<DialogList label="x" items={[{ text: EVIL }]} /></div>)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getAllByText(EVIL).length).toBeGreaterThan(0)
  })
  it('el título de página y los logs no interpretan HTML', () => {
    const { container } = render(
      <>
        <PageHeader title={EVIL} />
        <LogViewer follow={false} label="logs" lines={[{ stream: 'stdout', timestamp: null, message: `[ERROR] ${EVIL}`, truncated: false }]} />
      </>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('h1')?.textContent).toBe(EVIL)
    expect(screen.getAllByText(EVIL).length).toBeGreaterThan(0)
  })
  it('inspect: tokenizeJson conserva el texto literal (sin HTML)', () => {
    const t = tokenizeJson({ Env: [EVIL] })
    expect(t.map((x) => x.text).join('')).toContain(EVIL.replace(/"/g, '\\"'))
  })
  it('la lista de contenedores (datos del store) no crea <img>', async () => {
    const api = createSimApi({ latency: 0 })
    api.sim.world.containers[0].names = [EVIL]
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const { container } = render(<EngineProvider api={api}><NamesList /></EngineProvider>)
    await screen.findByText(EVIL)
    expect(container.querySelector('img')).toBeNull()
    expect(alertSpy).not.toHaveBeenCalled()
  })
})

describe('planDescribe: ítems con id repetido (prune_images, una fila por etiqueta)', () => {
  it('no emite warnings de key duplicada', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const plan: ActionPlan = {
      decision: { type: 'confirm' }, ticket: 't', expires_in_secs: 120, total_size_bytes: 10, warnings: [],
      affected: [
        { kind: 'image', id: 'sha256:aaa', name: 'nginx:1', size_bytes: 5 },
        { kind: 'image', id: 'sha256:aaa', name: 'nginx:latest', size_bytes: 5 },
      ],
    }
    render(<div>{describePlan(plan, { type: 'prune_images' }).description}</div>)
    expect(screen.getByText('nginx:1')).toBeInTheDocument()
    expect(screen.getByText('nginx:latest')).toBeInTheDocument()
    expect(err.mock.calls.filter((c) => String(c[0]).includes('same key'))).toHaveLength(0)
    err.mockRestore()
  })
})
