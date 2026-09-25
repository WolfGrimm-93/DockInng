import { AppShell } from './AppShell'
import { Providers } from './providers'

export default function App() {
  return (
    <Providers>
      <AppShell />
    </Providers>
  )
}
