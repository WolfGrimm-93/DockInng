import { ContainersPage } from '@/features/containers/ContainersPage'

export default function App() {
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
