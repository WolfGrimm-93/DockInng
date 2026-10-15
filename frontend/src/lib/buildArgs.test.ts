import { describe, expect, it } from 'vitest'
import { isReservedArgName } from './buildArgs'

describe('isReservedArgName (F-8, paridad con el backend)', () => {
  it('rechaza los prefijos del backend (BUILDKIT_, BUILDX_, COMPOSE_ incluidos)', () => {
    for (const n of ['DOCKER_HOST', 'BUILDKIT_PROGRESS', 'BUILDX_EXPERIMENTAL', 'COMPOSE_PROJECT_NAME', 'LD_PRELOAD', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK', 'LC_ALL']) {
      expect(isReservedArgName(n), n).toBe(true)
    }
  })
  it('rechaza las exactas y *_PROXY no listados como prefijo', () => {
    for (const n of ['PATH', 'home', 'HTTP_PROXY', 'https_proxy', 'NO_PROXY', 'GODEBUG', 'NODE_OPTIONS', 'TMPDIR', 'IFS', 'PWD']) {
      expect(isReservedArgName(n), n).toBe(true)
    }
  })
  it('acepta nombres normales y los que solo se parecen', () => {
    for (const n of ['VERSION', 'APP_ENV', 'PATHS', 'MY_PROXY_URL', 'BUILD_DATE', 'LDFLAGS', 'DOCKERFILE_TAG']) {
      expect(isReservedArgName(n), n).toBe(false)
    }
  })
  it('mayúsculas solo ASCII: «ſ» no equivale a «S» (como en Rust)', () => {
    expect(isReservedArgName('ſSH_AUTH_SOCK')).toBe(false)
  })
})
