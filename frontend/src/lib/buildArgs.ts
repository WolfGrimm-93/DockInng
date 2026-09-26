// Nombres de ARG de build que el backend rechaza (variables del entorno del proceso `docker build`): PATH, HOME, DOCKER_*, LD_*, XDG_*, SSH_*, LC_*, *_PROXY.
export const isReservedArgName = (name: string): boolean => /^(PATH|HOME)$/i.test(name) || /^(DOCKER|LD|XDG|SSH|LC)_/i.test(name) || /_PROXY$/i.test(name)
