import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import { ContainersPage } from '@/features/containers/ContainersPage'

export default function App() {
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return

    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<number>('close-confirmation-required', async (event) => {
      const message = event.payload === 1
        ? 'Hay una operación de Compose en curso. ¿Cerrar cuando termine?'
        : `Hay ${event.payload} operaciones de Compose en curso. ¿Cerrar cuando terminen?`
      if (window.confirm(message)) {
        await invoke('confirm_close')
      } else {
        await invoke('cancel_close')
      }
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="w-56 border-r p-4">
        <p className="mb-6 text-lg font-bold">DockInng</p>
        <nav className="space-y-1 text-sm">
          <p className="rounded-md bg-accent px-3 py-2 font-medium">Contenedores</p>
        </nav>
      </aside>
      <main className="flex-1 p-6">
        <ContainersPage />
      </main>
    </div>
  )
}
