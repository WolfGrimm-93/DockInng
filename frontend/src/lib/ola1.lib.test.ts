// Utilidades puras de la Ola 1: CIDR, referencias de imagen, binds sensibles, formulario de crear, diagnósticos de Compose, colores CSS y validadores.
import { describe, expect, it } from 'vitest'
import { cidrOverlaps, gatewayInside, isValidIp, parseCidr } from './cidr'
import { mergeDiagnostics, summarizeDiagnostics } from './composeDiag'
import { backendFieldToKey, imageIsLocal, toCreateSpec, validateCreateForm, type CreateForm } from './createForm'
import { lightenRgb, mixRgb, parseCssColor, toHexRgb } from './cssColor'
import { hasExplicitTag, normalizeImageRef, validateImageRef } from './imageRef'
import { parseFieldErrors, validateGateway, validateLabelKey, validateNetworkName, validateSubnet, validateVolumeName } from './resourceNames'
import { normalizePath, sensitiveBind } from './sensitiveBind'
import { validateCompose } from './yamlCheck'

describe('cidr', () => {
  it('IPv4: válidos e inválidos', () => {
    expect(parseCidr('172.30.0.0/16')).toMatchObject({ family: 4, prefix: 16 })
    for (const bad of ['172.30.0.0', '999.1.1.0/24', '10.0.0.0/33', '10.0.0/8', '01.2.3.4/8', 'a.b.c.d/8', '10.0.0.0/', '']) expect(parseCidr(bad), bad).toBeNull()
  })
  it('IPv6: compresión ::, IPv4 incrustado y prefijo hasta 128', () => {
    expect(parseCidr('fd00::/8')).toMatchObject({ family: 6, prefix: 8 })
    expect(parseCidr('2001:db8::1/64')).not.toBeNull()
    expect(parseCidr('::ffff:1.2.3.4/96')).not.toBeNull()
    expect(parseCidr('fd00::/129')).toBeNull()
    expect(parseCidr('fd00:::1/64')).toBeNull()
    expect(parseCidr('1:2:3:4:5:6:7:8:9/64')).toBeNull()
    expect(isValidIp('::1')).toBe(true)
    expect(isValidIp('10.0.0.256')).toBe(false)
  })
  it('puerta de enlace dentro de la subred y solapamiento', () => {
    expect(gatewayInside('10.99.0.0/24', '10.99.0.1')).toBe(true)
    expect(gatewayInside('10.99.0.0/24', '10.98.0.1')).toBe(false)
    expect(gatewayInside('10.99.0.0/24', 'fd00::1')).toBe(false)
    expect(cidrOverlaps('172.20.0.0/16', '172.20.5.0/24')).toBe(true)
    expect(cidrOverlaps('172.20.0.0/16', '172.21.0.0/16')).toBe(false)
    expect(cidrOverlaps('10.0.0.0/8', 'fd00::/8')).toBe(false)
    expect(cidrOverlaps('fd00::/8', 'fd00:1::/32')).toBe(true)
  })
})

describe('imageRef', () => {
  it('normaliza etiqueta latest, docker.io y registros con puerto', () => {
    expect(normalizeImageRef('postgres')).toBe('postgres:latest')
    expect(normalizeImageRef('docker.io/library/postgres:16')).toBe('postgres:16')
    expect(normalizeImageRef('localhost:5000/x')).toBe('localhost:5000/x:latest')
    expect(normalizeImageRef('localhost:5000/x:2')).toBe('localhost:5000/x:2')
    expect(normalizeImageRef('x@sha256:abc')).toBe('x@sha256:abc')
    expect(hasExplicitTag('localhost:5000/x')).toBe(false)
    expect(hasExplicitTag('x:1')).toBe(true)
  })
  it('validación ligera con mensajes en español', () => {
    expect(validateImageRef('')).toMatch(/Indica/)
    expect(validateImageRef('con espacios')).toMatch(/espacios/)
    expect(validateImageRef('-x')).toMatch(/guion/)
    expect(validateImageRef('Nginx')).toMatch(/minúsculas/)
    expect(validateImageRef('a'.repeat(300))).toMatch(/larga/)
    expect(validateImageRef('ghcr.io/casaluna/tienda-api:2.4.1')).toBeNull()
    expect(validateImageRef('postgres@sha256:' + 'a'.repeat(64))).toBeNull()
  })
  it('imageIsLocal compara la forma normalizada', () => {
    const imgs = [{ reference: 'postgres:latest', id: 'sha256:abc' }]
    expect(imageIsLocal(imgs, 'postgres')).toBe(true)
    expect(imageIsLocal(imgs, 'redis')).toBe(false)
  })
})

describe('sensitiveBind', () => {
  it('detecta docker.sock, rutas raíz y directorios de credenciales, también con // y /../', () => {
    expect(sensitiveBind('/var/run/docker.sock')?.level).toBe('danger')
    expect(sensitiveBind('/run/user/1000/docker.sock')?.level).toBe('danger')
    expect(sensitiveBind('/')?.text).toMatch(/raíz/)
    expect(sensitiveBind('//etc//')?.level).toBe('danger')
    expect(sensitiveBind('/srv/../etc')?.level).toBe('danger')
    expect(sensitiveBind('~')?.level).toBe('danger')
    expect(sensitiveBind('~/.ssh/id_rsa')?.text).toMatch(/\.ssh/)
    expect(sensitiveBind('/etc/hosts', false)?.level).toBe('warn')
    expect(sensitiveBind('/etc/hosts', true)).toBeNull()
  })
  it('no avisa de rutas normales ni de volúmenes con nombre', () => {
    expect(sensitiveBind('/srv/datos')).toBeNull()
    expect(sensitiveBind('~/proyectos/x')).toBeNull()
    expect(sensitiveBind('datos-pg')).toBeNull()
    expect(normalizePath('relativa')).toBeNull()
  })
})

const base = (o: Partial<CreateForm> = {}): CreateForm => ({
  image: 'nginx:1.27-alpine', name: '', command: '', restart: 'no', network: 'bridge',
  ports: [{ id: 'p1', hostIp: 'local', host: '8081', container: '80', protocol: 'tcp' }], vols: [{ id: 'v1', source: '', target: '', readOnly: false }], env: [{ id: 'e1', key: '', value: '' }], ...o,
})
const ctx = { containerNames: ['dup'], publishedPorts: new Map([[8080, 'web']]), networks: ['bridge', 'mi-red'] }

describe('createForm', () => {
  it('formulario correcto: sin errores; filas vacías se ignoran', () => {
    expect(validateCreateForm(base(), ctx).order).toEqual([])
  })
  it('todos los mensajes por campo, en orden', () => {
    const f = base({
      image: 'con espacios', name: 'dup',
      ports: [{ id: 'p1', hostIp: 'local', host: '8080', container: '80', protocol: 'tcp' }, { id: 'p2', hostIp: 'local', host: '8080', container: '0x', protocol: 'tcp' }],
      vols: [{ id: 'v1', source: './rel', target: 'no-abs', readOnly: false }, { id: 'v2', source: '', target: '/x', readOnly: false }],
      env: [{ id: 'e1', key: '1MAL', value: 'x' }, { id: 'e2', key: 'OK', value: '' }, { id: 'e3', key: 'OK', value: '' }], network: 'inexistente',
    })
    const { errors } = validateCreateForm(f, ctx)
    expect(errors.image).toMatch(/espacios/)
    expect(errors.name).toBe('Ya existe un contenedor llamado dup.')
    expect(errors['ports.p1.host']).toBe('El puerto 8080 del equipo ya lo usa web.')
    expect(errors['ports.p2.container']).toMatch(/1 a 65535/)
    expect(errors['vols.v1.source']).toMatch(/relativas/)
    expect(errors['vols.v1.target']).toMatch(/absoluta/)
    expect(errors['vols.v2.source']).toMatch(/Indica el origen/)
    expect(errors['env.e1.key']).toMatch(/no válido/)
    expect(errors['env.e3.key']).toBe('Variable repetida.')
    expect(errors.network).toMatch(/No existe la red/)
  })
  it('puerto de host duplicado dentro del formulario y por interfaz distinta sí se admite', () => {
    const dupe = base({ ports: [{ id: 'a', hostIp: 'local', host: '9000', container: '80', protocol: 'tcp' }, { id: 'b', hostIp: 'local', host: '9000', container: '81', protocol: 'tcp' }] })
    expect(validateCreateForm(dupe, ctx).errors['ports.b.host']).toMatch(/otra fila/)
    const ok = base({ ports: [{ id: 'a', hostIp: 'local', host: '9000', container: '80', protocol: 'tcp' }, { id: 'b', hostIp: 'all', host: '9000', container: '81', protocol: 'tcp' }] })
    expect(validateCreateForm(ok, ctx).order).toEqual([])
  })
  it('toCreateSpec: números, host_ip por interfaz, filas vacías fuera, comando y solo lectura', () => {
    const spec = toCreateSpec(base({
      name: ' web ', command: ' sleep 1 ', ports: [{ id: 'a', hostIp: 'all', host: '8081', container: '80', protocol: 'udp' }, { id: 'b', hostIp: 'local', host: '', container: '443', protocol: 'tcp' }],
      vols: [{ id: 'v', source: '/srv/x', target: '/x', readOnly: true }], env: [{ id: 'e', key: 'A', value: 'b=c' }],
    }))
    expect(spec).toMatchObject({ image: 'nginx:1.27-alpine', name: 'web', command: 'sleep 1', restart: 'no', restart_max_retries: null, labels: {} })
    expect(spec.ports).toEqual([{ host_ip: '0.0.0.0', host_port: 8081, container_port: 80, protocol: 'udp' }, { host_ip: null, host_port: null, container_port: 443, protocol: 'tcp' }])
    expect(spec.volumes).toEqual([{ source: '/srv/x', target: '/x', read_only: true }])
    expect(spec.env).toEqual([{ key: 'A', value: 'b=c' }])
  })
  it('backendFieldToKey traduce los índices del backend a las filas del formulario', () => {
    const f = base({ ports: [{ id: 'blank', hostIp: 'local', host: '', container: '', protocol: 'tcp' }, { id: 'p', hostIp: 'local', host: '1', container: '2', protocol: 'tcp' }] })
    expect(backendFieldToKey(f, 'ports[0].host_port')).toBe('ports.p.host')
    expect(backendFieldToKey(f, 'name')).toBe('name')
    expect(backendFieldToKey(f, 'volumes[9].source')).toBe('volumes[9].source')
  })
})

describe('composeDiag', () => {
  it('sin respuesta del backend: capa local; con respuesta: mandan los errores de Compose y se conservan los avisos locales', () => {
    const local = validateCompose('services:\n  web:\n\tports:\n', 'A=1')
    const only = mergeDiagnostics(local, null)
    expect(only.some((d) => d.source === 'local' && d.level === 'error' && d.line === 3)).toBe(true)
    const merged = mergeDiagnostics(validateCompose('services:\n  web:\n    image: x\n    environment:\n      V: ${FALTA}\n', ''), [{ line: 2, column: 3, kind: 'syntax', message: 'boom' }, { line: null, column: null, kind: 'schema', message: 'esquema' }])
    expect(merged[0]).toMatchObject({ line: 2, column: 3, source: 'compose', level: 'error' })
    expect(merged.at(-1)).toMatchObject({ line: null })
    expect(merged.some((d) => d.level === 'warn' && d.source === 'local')).toBe(true)
    expect(merged.some((d) => d.source === 'local' && d.level === 'error')).toBe(false)
  })
  it('resumen para el lector de pantalla', () => {
    expect(summarizeDiagnostics([], 4)).toBe('Sintaxis correcta · 4 servicios')
    expect(summarizeDiagnostics([], 1)).toBe('Sintaxis correcta · 1 servicio')
    expect(summarizeDiagnostics([{ level: 'error', line: 1, column: null, message: '', source: 'compose' }, { level: 'error', line: 2, column: null, message: '', source: 'compose' }, { level: 'warn', line: null, column: null, message: '', source: 'local' }], 3)).toBe('2 errores, 1 aviso')
  })
})

describe('cssColor', () => {
  it('lee hex, rgb(), oklch() y color(srgb) y hace mezclas', () => {
    expect(parseCssColor('#0a110e')).toEqual([10, 17, 14])
    expect(parseCssColor('#fff')).toEqual([255, 255, 255])
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3])
    expect(parseCssColor('rgba(1 2 3 / 0.5)')).toEqual([1, 2, 3])
    expect(parseCssColor('color(srgb 1 0 0.5)')).toEqual([255, 0, 128])
    const o = parseCssColor('oklch(0.17 0.014 165)')!
    expect(o.every((v) => v >= 0 && v < 60)).toBe(true) // fondo oscuro
    expect(parseCssColor('oklch(0.9 0.01 165)')!.every((v) => v > 200)).toBe(true)
    expect(parseCssColor('no-es-color')).toBeNull()
    expect(toHexRgb([10, 17, 14])).toBe('#0a110e')
    expect(mixRgb([0, 0, 0], [100, 200, 250], 0.5)).toEqual([50, 100, 125])
    expect(lightenRgb([0, 0, 0], 1)).toEqual([255, 255, 255])
  })
})

describe('resourceNames', () => {
  it('volúmenes', () => {
    expect(validateVolumeName('', [])).toMatch(/Escribe/)
    expect(validateVolumeName('a', [])).toMatch(/Mínimo 2/)
    expect(validateVolumeName('-mal', [])).toMatch(/empieza/)
    expect(validateVolumeName('ok', ['ok'])).toMatch(/Ya existe/)
    expect(validateVolumeName('datos_1.x-y', [])).toBeNull()
    expect(validateLabelKey('proyecto')).toBeNull()
    expect(validateLabelKey('com.docker.compose.project')).toMatch(/reservado/)
    expect(validateLabelKey('Mayús')).toMatch(/no válida/)
  })
  it('redes, subredes y puertas de enlace', () => {
    expect(validateNetworkName('Host', [])).toMatch(/reservado/)
    expect(validateNetworkName('mi-red', ['mi-red'])).toMatch(/Ya existe/)
    expect(validateNetworkName('mi-red', [])).toBeNull()
    expect(validateSubnet('', [])).toBeNull()
    expect(validateSubnet('xx', [])).toMatch(/CIDR/)
    expect(validateSubnet('172.20.1.0/24', [{ name: 'a', subnets: ['172.20.0.0/16'] }])).toMatch(/Se solapa con la red «a»/)
    expect(validateGateway('10.0.0.1', '')).toMatch(/necesita una subred/)
    expect(validateGateway('10.0.0.999', '10.0.0.0/24')).toMatch(/no válida/)
    expect(validateGateway('10.0.1.1', '10.0.0.0/24')).toMatch(/dentro de la subred/)
    expect(validateGateway('10.0.0.1', '10.0.0.0/24')).toBeNull()
  })
})

describe('parseFieldErrors (errores del backend «campo: mensaje; campo: mensaje»)', () => {
  it('separa por campo conocido y deja el resto como error general', () => {
    expect(parseFieldErrors('name: nombre no válido; labels[0]: clave reservada; algo raro', ['name', 'labels'])).toEqual({
      fields: { name: 'nombre no válido', labels: 'clave reservada' }, rest: 'algo raro',
    })
    expect(parseFieldErrors('boom', ['name'])).toEqual({ fields: {}, rest: 'boom' })
    expect(parseFieldErrors('subnet: mal; subnet: peor', ['subnet']).fields.subnet).toBe('mal; peor')
  })
})
