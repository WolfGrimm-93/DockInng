import { useSyncExternalStore } from 'react'

export type BuildStatus = 'idle' | 'running' | 'done' | 'canceled' | 'error'
export interface BuildState {
  status: BuildStatus
  step: number
  total: number
  lines: string[]
  error: string | null
}

const initial: BuildState = { status: 'idle', step: 0, total: 0, lines: [], error: null }
let state: BuildState = initial
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((listener) => listener())
const setState = (next: BuildState) => { state = next; emit() }

export const buildStore = {
  getState: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
  start() {
    if (state.status === 'running') return
    if (timer) clearInterval(timer)
    const total = 6
    setState({ status: 'running', step: 0, total, lines: ['Sending build context…'], error: null })
    let step = 0
    timer = setInterval(() => {
      step += 1
      if (step > total) {
        if (timer) clearInterval(timer)
        timer = null
        setState({ ...state, status: 'done', step: total, lines: [...state.lines, 'Successfully built image'] })
        return
      }
      setState({ ...state, step, lines: [...state.lines, `Step ${step}/${total}`] })
    }, 300)
  },
  cancel() {
    if (timer) clearInterval(timer)
    timer = null
    if (state.status === 'running') setState({ ...state, status: 'canceled', lines: [...state.lines, 'Build canceled'] })
  },
  fail(error: string) {
    if (timer) clearInterval(timer)
    timer = null
    if (state.status === 'running') setState({ ...state, status: 'error', error, lines: [...state.lines, error] })
  },
  reset() { this.cancel(); setState(initial) },
}

export function useBuildState(): BuildState {
  return useSyncExternalStore(buildStore.subscribe, buildStore.getState, buildStore.getState)
}

export function hasActiveBuild(build: BuildState = state): boolean {
  return build.status === 'running'
}
