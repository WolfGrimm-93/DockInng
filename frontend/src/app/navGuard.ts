type NavigationBlocker = () => boolean

const blockers = new Set<NavigationBlocker>()

export function registerNavigationBlocker(blocker: NavigationBlocker): () => void {
  blockers.add(blocker)
  return () => blockers.delete(blocker)
}

export function canNavigate(): boolean {
  for (const blocker of blockers) {
    if (!blocker()) return false
  }
  return true
}
