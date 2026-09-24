import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { isDesktop, listContainers, type Container } from '@/lib/engine'

export function ContainersPage() {
  const [containers, setContainers] = useState<Container[]>([])
  const [showAll, setShowAll] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // `reload` fuerza una recarga manual; luego se reemplazará por eventos en vivo de Docker.
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    listContainers(showAll)
      .then((list) => {
        if (cancelled) return
        setContainers(list)
        setError(null)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [showAll, reload])

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Contenedores</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Solo activos' : 'Mostrar todos'}
          </Button>
          <Button onClick={() => setReload((n) => n + 1)}>Actualizar</Button>
        </div>
      </header>

      {!isDesktop && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Modo navegador: mostrando datos de muestra. Abre la app de escritorio para ver Docker real.
        </p>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nombre</TableHead>
            <TableHead>Imagen</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Stack</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {containers.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.names[0] ?? c.id.slice(0, 12)}</TableCell>
              <TableCell>{c.image}</TableCell>
              <TableCell>
                <Badge variant={c.state === 'running' ? 'default' : 'secondary'}>{c.status}</Badge>
              </TableCell>
              <TableCell>{c.compose_project ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}
