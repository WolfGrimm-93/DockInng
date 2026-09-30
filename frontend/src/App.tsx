import { ContainersPage } from '@/features/containers/ContainersPage'
import { BuildPage } from '@/features/images/BuildPage'
import { canNavigate } from '@/app/navGuard'
import { useState } from 'react'

export default function App() {
  const [page, setPage] = useState<'containers' | 'build'>('containers')
  const navigate = (next: 'containers' | 'build') => {
    if (next === page || canNavigate()) setPage(next)
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="w-56 border-r p-4">
        <p className="mb-6 text-lg font-bold">DockInng</p>
        <nav className="space-y-1 text-sm">
          <button className={`block w-full rounded-md px-3 py-2 text-left font-medium ${page === 'containers' ? 'bg-accent' : ''}`} onClick={() => navigate('containers')}>Contenedores</button>
          <button className={`block w-full rounded-md px-3 py-2 text-left font-medium ${page === 'build' ? 'bg-accent' : ''}`} onClick={() => navigate('build')}>Construir</button>
        </nav>
      </aside>
      <main className="flex-1 p-6">
        {page === 'containers' ? <ContainersPage /> : <BuildPage />}
      </main>
    </div>
  )
}
