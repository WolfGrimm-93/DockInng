import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { registerNavigationBlocker } from '@/app/navGuard'
import { buildStore, hasActiveBuild, useBuildState } from '@/data/store/buildStore'

export function BuildPage() {
  const build = useBuildState()

  useEffect(() => {
    const blocker = registerNavigationBlocker(() => {
      if (!hasActiveBuild()) return true
      return window.confirm('Hay una construcción en curso. Si sales, conservarás su progreso, pero dejarás de verla. ¿Salir?')
    })
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasActiveBuild()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      blocker()
    }
  }, [])

  return (
    <section className="max-w-3xl space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Construir</h1>
          <p className="text-sm text-muted-foreground">El progreso permanece al cambiar de sección.</p>
        </div>
        {build.status === 'running' ? (
          <Button variant="outline" onClick={() => buildStore.cancel()}>Cancelar construcción</Button>
        ) : (
          <Button onClick={() => buildStore.start()}>{build.status === 'idle' ? 'Iniciar construcción' : 'Construir de nuevo'}</Button>
        )}
      </header>

      {build.status === 'idle' && <p className="rounded-md border p-4 text-sm">Configura el contexto de build y comienza una construcción.</p>}
      {build.status !== 'idle' && (
        <section className="space-y-3 rounded-md border p-4" aria-label="Progreso de la construcción">
          <div className="flex justify-between text-sm">
            <strong>{build.status === 'running' ? 'Construyendo…' : build.status === 'done' ? 'Construcción terminada' : build.status === 'error' ? 'La construcción falló' : 'Construcción cancelada'}</strong>
            <span>{build.step}/{build.total}</span>
          </div>
          <progress className="w-full" max={build.total || 1} value={build.step} />
          <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">{build.lines.join('\n')}</pre>
          {build.error && <p className="text-sm text-red-500">{build.error}</p>}
        </section>
      )}
    </section>
  )
}
