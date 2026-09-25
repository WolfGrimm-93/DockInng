// ThemeProvider: sincroniza el estado con el DOM al montar y reacciona a prefers-color-scheme cuando el modo es «Sistema».
import { useEffect, type ReactNode } from 'react'
import { watchSystemMode } from './apply'
import { useThemeStore } from './useTheme'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useThemeStore((s) => s.prefs.mode)
  useEffect(() => useThemeStore.getState().init(), [])
  useEffect(() => (mode === 'system' ? watchSystemMode(() => useThemeStore.getState().syncSystem()) : undefined), [mode])
  return <>{children}</>
}
