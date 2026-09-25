/* DockInng — datos de ejemplo de la plantilla (nada aquí es real). */
window.DK = (function () {
  'use strict';
  var STATUS = {
    running: { label: 'En ejecución', icon: 'dot' },
    paused: { label: 'Pausado', icon: 'pause', fill: true },
    restarting: { label: 'Reiniciando', icon: 'rotate' },
    exited: { label: 'Detenido', icon: 'square', fill: true },
    dead: { label: 'Muerto', icon: 'xcircle' },
    created: { label: 'Creado', icon: 'dashed' }
  };
  var containers = [
    { name: 'tienda-web-1', image: 'nginx:1.27-alpine', id: '3f9a1c7e02b4', status: 'running', ports: '8080:80', cpu: 0.4, mem: 12, stack: 'tienda', up: 'hace 3 días', vols: [], bind: [] },
    { name: 'tienda-api-1', image: 'ghcr.io/casaluna/tienda-api:2.4.1', id: '9b2e5d81a7c0', status: 'running', ports: '3000:3000', cpu: 6.8, mem: 214, stack: 'tienda', up: 'hace 3 días', vols: [], bind: ['~/proyectos/tienda/uploads'] },
    { name: 'tienda-postgres-1', image: 'postgres:16.4', id: 'c41d0a9be3f2', status: 'running', ports: '5432:5432', cpu: 2.1, mem: 168, stack: 'tienda', up: 'hace 3 días', vols: ['tienda_postgres-datos'], bind: [] },
    { name: 'tienda-redis-1', image: 'redis:7.4-alpine', id: '7ae8f2136b59', status: 'running', ports: '6379', cpu: 0.6, mem: 9, stack: 'tienda', up: 'hace 3 días', vols: ['tienda_redis-datos'], bind: [] },
    { name: 'tienda-worker-1', image: 'ghcr.io/casaluna/tienda-worker:2.4.1', id: 'e05b7c34d918', status: 'restarting', ports: '—', cpu: 0, mem: 0, stack: 'tienda', up: 'reiniciando (3)', vols: [], bind: [] },
    { name: 'monitoreo-prometheus-1', image: 'prom/prometheus:v2.54.1', id: '1d6f9e40c2a7', status: 'running', ports: '9090:9090', cpu: 1.3, mem: 142, stack: 'monitoreo', up: 'hace 6 días', vols: ['monitoreo_prometheus-tsdb'], bind: [] },
    { name: 'monitoreo-grafana-1', image: 'grafana/grafana:11.2.0', id: 'b8c3a51f7d64', status: 'running', ports: '3001:3000', cpu: 0.9, mem: 96, stack: 'monitoreo', up: 'hace 6 días', vols: ['monitoreo_grafana-datos'], bind: [] },
    { name: 'monitoreo-loki-1', image: 'grafana/loki:3.1.1', id: '5c2d8e9a1b30', status: 'paused', ports: '3100', cpu: 0, mem: 71, stack: 'monitoreo', up: 'en pausa', vols: [], bind: [] },
    { name: 'traefik-proxy', image: 'traefik:v3.1', id: 'a70e4b26f8d1', status: 'running', ports: '80, 443', cpu: 0.2, mem: 34, stack: null, up: 'hace 12 días', vols: [], bind: ['/var/run/docker.sock'] },
    { name: 'minio-dev', image: 'minio/minio:RELEASE.2024-09-13T20-26-02Z', id: '2f8b6d05e7a3', status: 'exited', ports: '9000, 9001', cpu: 0, mem: 0, stack: null, up: 'salió (0) hace 2 h', vols: ['minio-dev-datos'], bind: [] },
    { name: 'mailpit-pruebas', image: 'axllent/mailpit:v1.20', id: '84e1c7a09b25', status: 'exited', ports: '8025', cpu: 0, mem: 0, stack: null, up: 'salió (137) hace 1 día', vols: [], bind: [] },
    { name: 'respaldo-nocturno', image: 'casaluna/pg-backup:1.3', id: 'f3a92d17c6b8', status: 'dead', ports: '—', cpu: 0, mem: 0, stack: null, up: 'error al detener', vols: [], bind: [] },
    { name: 'wiki-outline-1', image: 'outlinewiki/outline:0.82', id: '06d5b3e8a1f9', status: 'created', ports: '3005:3000', cpu: 0, mem: 0, stack: null, up: 'sin iniciar', vols: [], bind: [] }
  ];
  /* Arrancar este contenedor falla la primera vez (demuestra el estado de error por fila) */
  var failStart = { 'mailpit-pruebas': 'El puerto 8025 ya lo usa otro proceso del equipo.' };
  var images = [
    { repo: 'ghcr.io/casaluna/tienda-api', tag: '2.4.1', id: '4be91a20c7d3', size: 412, created: 'hace 3 días', used: 1 },
    { repo: 'ghcr.io/casaluna/tienda-worker', tag: '2.4.1', id: '81f3d5c69e02', size: 398, created: 'hace 3 días', used: 1 },
    { repo: 'postgres', tag: '16.4', id: 'a19c6e3b7f40', size: 434, created: 'hace 5 semanas', used: 1 },
    { repo: 'nginx', tag: '1.27-alpine', id: 'd25f8a01b96c', size: 52, created: 'hace 3 semanas', used: 1 },
    { repo: 'redis', tag: '7.4-alpine', id: '3c70e9b4d158', size: 61, created: 'hace 2 semanas', used: 1 },
    { repo: 'prom/prometheus', tag: 'v2.54.1', id: 'e6b12f8a3c95', size: 289, created: 'hace 4 semanas', used: 1 },
    { repo: 'grafana/grafana', tag: '11.2.0', id: '5a0d7c93e1b8', size: 497, created: 'hace 6 semanas', used: 1 },
    { repo: 'grafana/loki', tag: '3.1.1', id: '92e4b6d0a7f3', size: 105, created: 'hace 7 semanas', used: 1 },
    { repo: 'traefik', tag: 'v3.1', id: 'c8f1a35d20e6', size: 189, created: 'hace 2 semanas', used: 1 },
    { repo: 'minio/minio', tag: 'RELEASE.2024-09-13T20-26-02Z', id: '17b9e4c5f3a2', size: 241, created: 'hace 2 semanas', used: 1 },
    { repo: 'node', tag: '20-bookworm-slim', id: 'f40c2a86d9b1', size: 230, created: 'hace 8 semanas', used: 0 },
    { repo: '<none>', tag: '<none>', id: '0d9b5e71c3a8', size: 405, created: 'hace 3 semanas', used: 0 }
  ];
  var volumes = [
    { name: 'tienda_postgres-datos', driver: 'local', mount: '/var/lib/docker/volumes/tienda_postgres-datos/_data', size: '1.8 GB', mb: 1843, used: ['tienda-postgres-1'] },
    { name: 'tienda_redis-datos', driver: 'local', mount: '/var/lib/docker/volumes/tienda_redis-datos/_data', size: '24 MB', mb: 24, used: ['tienda-redis-1'] },
    { name: 'monitoreo_prometheus-tsdb', driver: 'local', mount: '/var/lib/docker/volumes/monitoreo_prometheus-tsdb/_data', size: '3.2 GB', mb: 3277, used: ['monitoreo-prometheus-1'] },
    { name: 'monitoreo_grafana-datos', driver: 'local', mount: '/var/lib/docker/volumes/monitoreo_grafana-datos/_data', size: '58 MB', mb: 58, used: ['monitoreo-grafana-1'] },
    { name: 'minio-dev-datos', driver: 'local', mount: '/var/lib/docker/volumes/minio-dev-datos/_data', size: '640 MB', mb: 640, used: ['minio-dev'] },
    { name: 'respaldos-pg', driver: 'local', mount: '/var/lib/docker/volumes/respaldos-pg/_data', size: '5.4 GB', mb: 5530, used: [] },
    { name: '8c1f0e3a7b52d94e6f01a3c8b5d72e90', driver: 'local', mount: '/var/lib/docker/volumes/8c1f0e3a7b52d94e6f01a3c8b5d72e90/_data', size: '12 MB', mb: 12, used: [] }
  ];
  var networks = [
    { name: 'bridge', driver: 'bridge', scope: 'local', subnet: '172.17.0.0/16', n: 2, sys: true },
    { name: 'host', driver: 'host', scope: 'local', subnet: '—', n: 0, sys: true },
    { name: 'none', driver: 'null', scope: 'local', subnet: '—', n: 0, sys: true },
    { name: 'tienda_default', driver: 'bridge', scope: 'local', subnet: '172.20.0.0/16', n: 5, sys: false },
    { name: 'monitoreo_default', driver: 'bridge', scope: 'local', subnet: '172.21.0.0/16', n: 3, sys: false },
    { name: 'proxy-publico', driver: 'bridge', scope: 'local', subnet: '172.22.0.0/24', n: 3, sys: false }
  ];
  var stacks = [
    { name: 'tienda', path: '~/proyectos/tienda/docker-compose.yml', services: [
      ['web', 'nginx:1.27-alpine', 'running', '1/1'], ['api', 'tienda-api:2.4.1', 'running', '1/1'],
      ['postgres', 'postgres:16.4', 'running', '1/1'], ['redis', 'redis:7.4-alpine', 'running', '1/1'],
      ['worker', 'tienda-worker:2.4.1', 'restarting', '0/1']] },
    { name: 'monitoreo', path: '~/infra/monitoreo/compose.yaml', services: [
      ['prometheus', 'prom/prometheus:v2.54.1', 'running', '1/1'], ['grafana', 'grafana/grafana:11.2.0', 'running', '1/1'],
      ['loki', 'grafana/loki:3.1.1', 'paused', '1/1']] }
  ];
  var connections = [
    { id: 'local', name: 'Local', sub: 'unix:///var/run/docker.sock', icon: 'monitor', ver: 'Docker 27.3.1 · API 1.47', ok: true, remote: false },
    { id: 'prod', name: 'prod-hetzner', sub: 'ssh://deploy@203.0.113.10', icon: 'server', ver: 'Docker 26.1.4 · API 1.45', ok: true, remote: true },
    { id: 'staging', name: 'staging-lab', sub: 'ssh://ops@192.168.1.40', icon: 'server', ver: '', ok: false, remote: true }
  ];
  var NAV = [
    ['containers', 'Contenedores', 'box'], ['images', 'Imágenes', 'layers'], ['volumes', 'Volúmenes', 'database'],
    ['networks', 'Redes', 'network'], ['stacks', 'Stacks (Compose)', 'grid'], ['settings', 'Configuración', 'sliders']
  ];
  /* vista -> ítem resaltado del menú */
  var NAV_OF = { containers: 'containers', detail: 'containers', create: 'containers', images: 'images', pull: 'images', volumes: 'volumes', networks: 'networks', stacks: 'stacks', 'stack-edit': 'stacks', settings: 'settings', 'conn-new': 'settings' };
  var TITLES = { containers: 'Contenedores', detail: 'Contenedor', create: 'Nuevo contenedor', images: 'Imágenes', pull: 'Descargar imagen', volumes: 'Volúmenes', networks: 'Redes', stacks: 'Stacks', 'stack-edit': 'Editar stack', settings: 'Configuración', 'conn-new': 'Nueva conexión' };

  /* Variantes del error de conexión: cada una con su propio diagnóstico */
  var ERRORS = {
    permission: {
      title: 'No se pudo conectar con el motor',
      lead: function (t, n) { return 'DockInng no obtuvo respuesta de ' + t + ' (conexión «' + n + '»). El socket existe pero tu usuario no puede usarlo.'; },
      steps: [
        ['ok', 'Socket', 'El archivo /var/run/docker.sock existe.', null, 'Correcto'],
        ['fail', 'Permisos y grupo docker', 'Tu usuario no pertenece al grupo docker, por eso el socket rechaza la conexión (permission denied).', 'sudo usermod -aG docker $USER', 'Falla', 'Cierra sesión y vuelve a entrar para que el cambio surta efecto.'],
        ['skip', 'Daemon', 'Sin comprobar: depende del paso anterior. Para verlo tú mismo:', 'systemctl is-active docker', 'Pendiente']
      ]
    },
    daemon: {
      title: 'El motor de Docker no está en ejecución',
      lead: function (t, n) { return 'Nadie escucha en ' + t + ' (conexión «' + n + '»). El servicio de Docker está detenido o no está instalado.'; },
      steps: [
        ['fail', 'Socket', 'No hay nadie escuchando en /var/run/docker.sock (connection refused).', null, 'Falla'],
        ['skip', 'Permisos y grupo docker', 'Sin comprobar: primero tiene que arrancar el motor.', 'id -nG | tr " " "\\n" | grep docker', 'Pendiente'],
        ['fail', 'Daemon', 'El servicio docker está inactivo.', 'sudo systemctl start docker', 'Falla', 'Para que arranque con el equipo: sudo systemctl enable docker']
      ]
    },
    ssh: {
      title: 'No se pudo conectar con staging-lab',
      lead: function (t, n) { return 'La conexión SSH a ' + t + ' no se completó.'; },
      steps: [
        ['ok', 'Red', 'El host 192.168.1.40 responde en el puerto 22.', null, 'Correcto'],
        ['fail', 'Autenticación SSH', 'El servidor rechazó la llave (Permission denied, publickey). Revisa el alias en ~/.ssh/config.', 'ssh staging-lab docker info', 'Falla', 'Si funciona en la terminal, comprueba que la llave esté cargada con ssh-add.'],
        ['skip', 'Socket remoto', 'Sin comprobar: hace falta autenticarse antes.', null, 'Pendiente']
      ]
    }
  };

  var logSeed = [
    ['INFO', 'Iniciando tienda-api 2.4.1 (node v20.17.0, NODE_ENV=production)'], ['INFO', 'Conectado a postgres://tienda-postgres-1:5432/tienda (pool: 10)'],
    ['INFO', 'Conectado a redis://tienda-redis-1:6379'], ['INFO', 'Servidor escuchando en 0.0.0.0:3000'], ['DEBUG', 'Cache miss clave=catalogo:destacados'],
    ['INFO', 'GET /api/productos?pagina=1 200 14ms'], ['INFO', 'GET /api/productos/8421 200 6ms'], ['DEBUG', 'Cache hit clave=carrito:8f21ab'],
    ['INFO', 'POST /api/carrito 201 22ms'], ['WARN', 'Consulta lenta (842 ms): SELECT * FROM pedidos WHERE cliente_id = $1 ORDER BY creado DESC'],
    ['INFO', 'GET /api/pedidos 200 851ms'], ['INFO', 'GET /salud 200 1ms'], ['INFO', 'POST /api/pagos/intencion 200 187ms'],
    ['ERROR', 'ECONNRESET al hablar con tienda-redis-1:6379, reintentando (1/5)'], ['WARN', 'Reintento de conexión a redis en 250 ms'],
    ['INFO', 'Conexión a redis restablecida'], ['INFO', 'GET /api/productos?categoria=cafe 200 11ms'], ['DEBUG', 'Cache miss clave=categoria:cafe'],
    ['ERROR', 'Webhook de pago rechazado: firma inválida (evento evt_1Q9xKf) — POST /api/pagos/webhook 400 3ms'], ['INFO', 'GET /salud 200 1ms'],
    ['WARN', 'Uso de memoria del heap al 78% (214 MiB de 275 MiB)'], ['INFO', 'POST /api/sesion 200 41ms'], ['INFO', 'GET /api/usuarios/yo 200 5ms'],
    ['INFO', 'PUT /api/carrito/8f21ab 200 18ms'], ['DEBUG', 'Serializando respuesta: 48 productos, 31.2 KB'], ['INFO', 'GET /api/productos?pagina=2 200 13ms']
  ];
  var liveLogs = [['INFO', 'GET /api/productos?pagina=3 200 12ms'], ['INFO', 'GET /salud 200 1ms'], ['DEBUG', 'Cache hit clave=catalogo:destacados'], ['WARN', 'Consulta lenta (611 ms): SELECT count(*) FROM pedidos'], ['INFO', 'POST /api/carrito 201 19ms'], ['ERROR', 'Tiempo de espera agotado al llamar a pasarela-pagos (5000 ms)']];

  var sampleYaml = [
    'name: tienda', '', 'services:',
    '  web:', '    image: nginx:1.27-alpine', '    ports:', '      - "8081:80"', '    depends_on: [api]',
    '  api:', '    image: ghcr.io/casaluna/tienda-api:2.4.1', '    environment:', '      DATABASE_URL: postgres://tienda:${POSTGRES_PASSWORD}@postgres:5432/tienda',
    '      REDIS_URL: redis://redis:6379', '    ports:', '      - "3000:3000"',
    '  postgres:', '    image: postgres:16.4', '    environment:', '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}', '    volumes:', '      - postgres-datos:/var/lib/postgresql/data',
    '  redis:', '    image: redis:7.4-alpine', '', 'volumes:', '  postgres-datos:'
  ].join('\n');
  var brokenYaml = ['name: tienda', '', 'services:', '  web:', '\tports:', '      - "8080:80"', '  api:', '    environment:', '      PORT: ${API_PORT}'].join('\n');
  var sampleEnv = ['# Variables de tienda', 'POSTGRES_PASSWORD=cambia-esto', 'TZ=America/Mexico_City'].join('\n');

  return { STATUS: STATUS, containers: containers, failStart: failStart, images: images, volumes: volumes, networks: networks, stacks: stacks, connections: connections, NAV: NAV, NAV_OF: NAV_OF, TITLES: TITLES, ERRORS: ERRORS, logSeed: logSeed, liveLogs: liveLogs, sampleYaml: sampleYaml, brokenYaml: brokenYaml, sampleEnv: sampleEnv };
})();
