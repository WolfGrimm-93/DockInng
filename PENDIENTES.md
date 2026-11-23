# Pendientes — DockInng

Ver detalle y contexto en Obsidian: `Proyectos/DockInng/DockInng - Pendientes.md`, `DockInng - Estado actual y reconciliación.md` y el historial en `DockInng - Bitácora.md`.

Lo ya cerrado se retiró de esta lista (2026-10-06); su historial está en la Bitácora de Obsidian.

## Auditoría completa front-back (2026-11-21)

Hallazgos de una lectura de código (4 revisores, solo lectura) más las puertas automáticas: `cargo test --workspace` en verde, clippy limpio, `pnpm lint`/`tsc`/`build` en verde. Los hallazgos salen de leer el código y deben reproducirse antes de arreglarlos. No se ejercieron los tests `live_*` (Docker, SSH, TLS reales). Sin hallazgos críticos.

**Alto**
- [x] **A1. `up` de un stack sin política de confirmación** (resuelto en `feature/auditoria-stack-up`). Un compose con `privileged`, `docker.sock`, red/PID del host o binds sensibles se levantaba sin ticket ni diálogo. Ahora el núcleo evalúa los riesgos del compose RESUELTO (`Action::StackUpSensitive`, `StackControl::assess_op`, `prepare_op_approved`, `StackApproval`), la app pide diálogo nativo, la CLI pregunta (`stacks up --yes` salta la confirmación simple) y `PreparedOp` rechaza con `policy_denied` si falta la aprobación o aparece un riesgo que la persona no vio. Pendiente: probarlo con Docker real y en ventana Tauri real (los tests usan `FakeSpawn` y diálogo falso).
- [x] **A2. Login HTTP sin límite de intentos** (resuelto en `feature/auditoria-servidor`). Longitudes máximas (usuario 256 B, contraseña 1024 B), bloqueo por IP (30 fallos) y por usuario (5 fallos) con espera creciente de 30 s a 15 min (429 + `Retry-After`, sin ejecutar Argon2 mientras está bloqueado), el usuario inexistente se trata igual, y Argon2 + SQLite corren en `spawn_blocking` con tope de 4 hashes simultáneos (el resto recibe 429). Límites asumidos: un atacante puede bloquear temporalmente a un usuario conocido; tras un proxy inverso todos comparten la IP del proxy (no se confía en `X-Forwarded-For`). El estado vive en memoria. Pendiente: probar con carga real y con un proxy delante.
- [x] **A3. Sesiones sin caducidad ni tope** (resuelto en `feature/auditoria-servidor`): TTL absoluto 12 h e inactivo 30 min (`SessionPolicy`), `Max-Age` en la cookie, máximo 5 sesiones por usuario (se descarta la menos usada) y purga de vencidas al crear. Valores fijos en código (sin variables de entorno todavía).
- [x] **A4. Modo `single` sin autenticación expuesto** (resuelto en `feature/auditoria-servidor`): `single` solo arranca en loopback; con otro bind falla con un mensaje claro salvo `DOCKINNG_SINGLE_ALLOW_EXPOSED=1`, que además deja un aviso al arrancar (igual que `INSECURE_COOKIES=1` fuera de loopback).

**Medio**
- [x] **M1. El webview decidía confirmaciones destructivas** (resuelto en `feature/auditoria-confirmaciones`): `connection_delete`, `registry_delete` y `connection_forget_host_key` ya no confían en el webview; la política decide y la aprobación es un diálogo NATIVO que describe el elemento real. Se quitó `confirmed` del IPC, del contrato y del frontend. **Abierto:** `quit_app(confirmed)` conserva el booleano a propósito (solo permite salir de la app; con operaciones en curso las aborta). Decidir si exige diálogo nativo cuando hay operaciones en curso. Pendiente: probar los diálogos en ventana Tauri real (los tests usan un diálogo falso).
- [x] **M2. Carrera al degradar/borrar admins** (resuelto en `feature/auditoria-m2-m7`): `user_set_role_keeping_admin` y `user_delete_keeping_admin` hacen la comprobación y el cambio en UNA sentencia SQL. Prueba con dos hilos que se degradan a la vez.
- [x] **M3. Usuarios y contraseñas** (resuelto en `feature/auditoria-m2-m7`, salvo lo anotado): usuario ASCII `[A-Za-z0-9._-]` de 3 a 64 (sin homógrafos, sin normalización Unicode porque ya no hay Unicode), contraseña de 8 a 128 caracteres (no bytes), mismas reglas para el admin de bootstrap (si no cumple, el servidor no arranca), Argon2 fuera del runtime, `PUT /api/users/{id}/password` (solo admin) que cierra las sesiones del usuario y hash señuelo calculado al arrancar. **Abierto:** cambio de contraseña por el propio usuario (exigiendo la actual); hoy solo la resetea un admin.
- [x] **M4. Compose: procesos huérfanos tras cancelar** (resuelto en `feature/auditoria-m2-m7`): `leader_reaped` y `group_done` por separado; `Drop` y `kill` rematan el grupo si `wait()` se cancela durante la espera. Reproducido antes de corregir con procesos reales (2 pruebas fallaban).
- [x] **M5. `StackStore::save`** (resuelto en `feature/auditoria-m2-m7`): `stack_save` toma el guard `busy` (choca con `up`/`down` en curso), el destino del `.env` se valida antes de escribir y, si falla su escritura, se restaura el compose anterior. `expectedRevision: null` NO es un fallo: es el «sobrescribir» que elige la persona tras un conflicto. **Abierto:** no hay bloqueo entre procesos (GUI y CLI a la vez); solo dentro del mismo proceso.
- [x] **M6. Sandbox de includes** (resuelto en `feature/auditoria-m2-m7`): segunda pasada con parseo YAML real (`serde_norway`) que se suma al escáner de texto; cierra 3 bypasses reproducidos (documento en estilo flujo, alias `*ancla`, escapes `\x2e\x2e` en comillas). `build.context`, `secrets.*.file` y `configs.*.file` hacia rutas sensibles ahora cuentan como riesgo y exigen aprobación en `up` (no se confinan: es habitual que vivan fuera del proyecto). **Aceptado/abierto:** el TOCTOU entre el análisis y la lectura de Compose sigue (pasar el YAML por stdin cambiaría las labels `config_files` con las que se enlazan los contenedores; quien pueda escribir en el proyecto ya tiene los privilegios del usuario). Si el YAML no parsea, solo actúa el escáner de texto.
- [x] **M7. `working_dir` de stack vinculado** (resuelto en `feature/auditoria-m2-m7`): `link` rechaza (explícito o derivado de la carpeta del archivo) `/`, `/home`, `$HOME`, `/etc`, `~/.ssh`... con el mismo criterio que los binds sensibles. Cambio de comportamiento: un compose que viva directamente en `$HOME` ya no se puede vincular (hay que moverlo a su carpeta).
- [ ] **M8. Logs sin sanear en la UI** (`LogViewer.tsx:58`, `LogsTab.tsx:46`): sin `safeText` ni limpieza de ANSI; controles bidi pueden invertir texto. No hay XSS.
- [ ] **M9. Carrera en el store del frontend** (`engineStore.ts:~228`): dos `list()` del mismo tipo pueden resolver desordenados. Contador por `kind`.
- [ ] **M10. `pnpm audit --prod`: 7 vulnerabilidades (2 altas, 4 moderadas, 1 baja)**; una es `vite` (parche ≥8.3.3, vía `@tailwindcss/vite`). Revisar las otras seis y correr `cargo audit` (no se corrió).
- [ ] **M11. Comandos de contenedor sin plan** (`commands.rs:206-222`: start/stop/restart directos). Aceptable si la política los clasifica `Allow` (lo hace); verificar paridad con la CLI.

**Bajo**
- [x] Limitador de login: el desalojo con el mapa lleno podía borrar la entrada de una IP (rociando nombres de usuario) y la prueba era intermitente; corregido en `feature/auditoria-m2-m7` (se desaloja primero lo de usuario y lo no bloqueado).
- [ ] Quitar la capability `dialog:allow-open` (`backend/app/capabilities/default.json:84`), sin uso desde el frontend.
- [ ] `check_paths_exist` (`commands_remote.rs:36-62`) actúa como oráculo de existencia de archivos: mensaje genérico o rutas por diálogo nativo.
- [ ] PKGBUILD con `sha256sums=('SKIP')`: fijar hash real antes de cualquier release.
- [ ] `groups_import_legacy` (`commands_store.rs:233`): comprobar límite de tamaño del payload.
- [ ] Servidor: cabeceras de seguridad (HSTS, `nosniff`, `no-store`), cookie `__Host-`, sin TLS propio (documentar proxy), avisar si `bind` no es loopback con `insecure_cookies`, timeouts y límites a nivel de router; comprobar que los errores de SQLite no lleguen crudos al cliente (`store/src/error.rs:47`).
- [ ] Almacén: crear `store.db` y `.bak-vN` con modo 0600 desde el principio; el `.bak` conserva hashes indefinidamente.
- [ ] `known_hosts` se lee entero sin tope (`transport/src/known_hosts.rs`).
- [ ] `engine-docker/src/exec.rs:~165`: carrera de PID reciclado en el cierre del exec; `close()` en `Drop` de la sesión.
- [ ] `broker.restore` ignora `MAX_PENDING` (`engine-core/src/broker.rs:~170`).
- [ ] Frontend: regex de nivel de log con mala precedencia (`lib/logLevel.ts:11`), casts inseguros (`adapters/tauri/index.ts:99`, `ContainerDetailPage:69,152`, `AppearanceSection:128,144`, `useCreateContainerForm:188`), doble parseo O(5000) en logs, accesibilidad (`CommandPalette.tsx:78`, `NewGroupDialog:41`), datos de demo en `ContainersPage:166`, `eslint-disable exhaustive-deps` a revisar (`LogViewer:31`, `XtermTerminal:158`, `devOnce:12`, `useVirtualTable:27`), sin i18n (textos en español hardcodeados). Verificar que `pnpm contract:check` corra en CI.
- [ ] Tests faltantes: `save` concurrente contra `acquire`, `reap_group` y cancelación durante la espera, `link` con `working_dir` raíz/`$HOME`.
- [ ] No auditado: `platilla-html/`, `scripts/`, CI.

## Servidor web (`backend/server`), rama `feature/web-server` — primera versión (2026-10-13)

Nuevo adaptador HTTP (`axum`), igual nivel que `dockinng-cli` y la app de escritorio: habla
contra `engine-core`/`engine-docker`, no reimplementa nada de Docker. Pensado para correr en
un contenedor y servirse por red, en dos modos:

- **`DOCKINNG_AUTH_MODE=single`**: sin login, todo pedido entra como admin sintético (mismo
  supuesto de confianza que hoy la app/CLI: red ya confiable). Sin esa variable, o con
  `multi`, el servidor exige sesión — **seguro por defecto**, hay que pedir `single` a propósito.
  `single` solo arranca en loopback: con otro `DOCKINNG_SERVER_BIND` se rechaza salvo
  `DOCKINNG_SINGLE_ALLOW_EXPOSED=1` (asumiendo que un proxy o túnel autentica delante).
- **`multi`**: usuarios y roles (`Admin`/`Operator`/`Viewer`, nuevo enum `Role` en
  `engine-core`), persistidos en `store` (tabla `users`, esquema v3, contraseña con Argon2).
  Sesión por cookie `HttpOnly`/`Secure`/`SameSite=Strict`, en memoria del proceso (ver
  pendiente abajo); caduca a las 12 h (con `Max-Age` en la cookie) o a los 30 min sin uso, y hay
  un máximo de 5 sesiones por usuario. El login frena la fuerza bruta (ver más abajo). Primer admin: `DOCKINNG_BOOTSTRAP_ADMIN_USER`/`_PASSWORD` al arrancar sin
  usuarios.

Endpoints: `/healthz`, `/api/auth/{login,logout,me}`, `/api/users` (CRUD, solo `admin`, no
deja borrar/degradar al último admin ni al propio usuario logueado), `/api/containers`
(prueba de concepto de lectura contra el motor real).

**Verificado, no solo compilado:** `cargo test --workspace` y
`cargo clippy --workspace --all-targets` limpios; además arranqué el binario real
(`target/debug/dockinng-server`) en ambos modos — en `single` devolvió los contenedores reales
del Docker de esta máquina por `/api/containers`; en `multi` con admin inicial por variables
de entorno, hice login real, confirmé la cookie en `/api/auth/me` y listé el usuario por
`/api/users`. Server y Store corrieron contra un socket Docker y un SQLite reales, no mocks.

**Pendiente — no es "terminado", falta para tener paridad o quedar listo para producción:**
- [ ] Solo hay un endpoint de lectura (`/api/containers`). No hay ninguna acción que modifique
  el motor todavía: falta conectar `Role::can_act()` con `ConfirmationPolicy` para exponer
  start/stop/remove/etc. por HTTP.
- [ ] Sin streaming: logs, stats y terminal (`exec`) no están portados. `backend/app` ya tiene
  la lógica de *backpressure*/*coalescing* desacoplada de Tauri detrás de un trait `Sink<T>`
  (`streams.rs`, `exec_sessions.rs`); portarla a WebSocket es el camino más corto, no reescribir.
- [ ] **Las sesiones viven en memoria del proceso: reiniciar el servidor desconecta a todos.**
  No hay persistencia de sesiones entre reinicios.
- [ ] No existe cliente web: el `frontend/` actual solo habla con Tauri. Falta una UI (o
  reutilizar la actual con una capa de transporte HTTP/WebSocket en vez de `invoke`).
- [ ] Sin containerización: no hay `Dockerfile`/compose para desplegar `dockinng-server` en un
  contenedor (que es el objetivo final pedido).
- [ ] `/api/auth/login` no tiene límite de intentos (solo mitiga el canal lateral de tiempo
  con un hash señuelo); falta *rate limiting* contra fuerza bruta.
- [ ] No hay registro de auditoría de acciones de administración (alta/baja/cambio de rol).
- [ ] El administrador inicial se crea desde variables de entorno con la contraseña en claro
  al arrancar; no hay una vía más segura (ej. prompt interactivo o rotación obligatoria).
- [ ] Decisión de diseño documentada, no bloqueante: el token de sesión usa UUID v4, no v7
  (excepción a la regla global, igual que `LOCAL_CONNECTION_ID` en `store`: es un secreto
  efímero, no un id de recurso — ver comentario en `server/src/session.rs`).
- [ ] Faltan pruebas de integración de los últimos dos endpoints de permiso fino que no llegué
  a cubrir con Docker real (solo con `MockEngine`): ningún endpoint de acción existe aún, así
  que esto se retoma junto con el ítem de arriba.

## Auditoría de correcciones (2026-10-06, integrada en develop)

Pendientes que quedaron abiertos tras las correcciones de la auditoría completa:

- [x] Creación de contenedor y construcción canjean su ticket con `confirmed=true` fijo. Cerrado en la segunda ronda de correcciones (backend): exigen `Approval` del diálogo nativo cuando la decisión lo pide.
- [x] `context rm` de la CLI pasa por el broker de tickets (`ActionRequest::RemoveConnection`, `ItemKind::Connection`). Cerrado en la segunda ronda de correcciones (backend).
- [x] `F-9`: inline styles, de 114 a 16. Los 16 que quedan son valores calculados en runtime (alturas de virtualización, porcentajes, colores de grupo/servicio, anchos de skeleton); no son candidatos a clase fija. Cerrado en la segunda ronda (frontend).
- [x] `F-12`: `CreateContainerPage.tsx` de 377 a 86 líneas; puertos, entorno, red y grupo pasaron a componentes propios y a `useCreateContainerForm.tsx`. Cerrado en la segunda ronda (frontend).
- [ ] Revisión visual en la app de los cambios de estilo (`--row-h`/`--head-h` en capa, tokens `--z-*`, renombrado a `workflows.css`, `connections-ops.css`, `interaction-chrome.css`, `ports-actions.css`) y de la nueva `CreateContainerPage` dividida. Solo se verificó build y tests, nunca en pantalla.
- [ ] Decidir: `truncate` de `compose` (cuenta bytes) y el de la CLI (caracteres) no se unifican porque cambiaría salidas; `is_remote` son cuatro cosas distintas.
- [ ] Reglas de argumentos de build y longitud de nombres: la lista de reservados y la validación están igualadas a mano entre frontend y backend (tests de paridad). Falta una fuente única vía contrato.
- [ ] Riesgo de la línea del webview: `execute_action` ya NO recibe `confirmed`; la aprobación la da un diálogo nativo (Tauri), construido solo por el adaptador de la app (`Approval::from_native_dialog()`) o el prompt de la CLI (`from_cli_prompt()`). PENDIENTE: `registry_delete`, `connection_delete` y `quit_app` siguen recibiendo `confirmed: bool` del webview (mismo bypass). Migrarlos al mismo `Approval` nativo. El diálogo nativo en sí no se probó en una ventana Tauri real (solo con un `ApprovalSource` falso en tests); falta esa prueba manual. Límite aceptado: quien acepta el diálogo sin leerlo aprueba igualmente.

## Ola 3: empaquetado

- [ ] Pasar `rpmlint` sin errores al RPM generado por Tauri: verificado en Fedora 44 con `rpmlint 2.8.0`; quedan 9 errores y 2 advertencias por documentación no marcada como `%doc`, `no-documentation`, `no-changelogname-tag`, `no-buildhost-tag` y nombre de archivo no coherente. El paquete instala/desinstala correctamente; documentar o corregir según lo que controle Tauri.
- [ ] Build completo del PKGBUILD con red (`pnpm install`, `cargo fetch`), con tag `v0.1.0` publicado y `updpkgsums`; `namcap` no reportó problemas, pero el tag todavía no existe en GitHub y `makepkg --verifysource` devuelve 404.
- [ ] Bandeja en Plasma: comprobar `tray.png` sobre paneles claro y oscuro, y `StartupWMClass=dockinng-app` en Wayland.
- [ ] Copia del RPM compatible con Leap a la ruta canónica (`backend/target-leap/...`): requiere `sudo` porque el directorio pertenece a `root`.

## Ola 2: pendientes tras la auditoría (rama `feature/wave2-persistence-remote`)

- [ ] **Parcialmente verificado con servidor real:** `live_real_ssh` pasó de nuevo el 2026-10-06 contra `debian-dev` (server01, solo lectura: ping 854 ms, info 195 ms, corte y reconexión 241 ms sin hijos residuales). Siguen sin verificar: Docker rootless (server01 es rootful, Docker 29.6.2); ProxyJump/alias complejos con TOFU (cubierto por test unitario `alias_con_proxy_falla_cerrado`, no en vivo); cortes físicos prolongados; dockerd con TLS real (requiere cambiar la config del daemon en server01). Las dos últimas exigen confirmación explícita antes de tocar el servidor.
- [ ] **Builds:** se fuerza `BUILDKIT_PROGRESS=plain` para poder auditar la salida, pero la interfaz actual todavía envía `--build-arg`; los valores marcados como secreto solo generan confirmación y siguen quedando visibles en `docker history` si el daemon usa el builder clásico. Para secretos reales debe usarse un Dockerfile con `RUN --mount=type=secret` y `docker build --secret`; no se implementa una fuente de secretos en esta versión. El borrado de la caché de build por elemento no está implementado; el parser de progreso es frágil entre versiones (se muestran siempre las líneas crudas).
- [ ] **Acceso remoto por túnel de Cloudflare desde la app:** `ssh debian-remote` funciona por consola (verificado 2026-10-06 con `ProxyCommand cloudflared access ssh --hostname %h` y huella igual a la LAN), pero DockInng rechaza los alias con `ProxyCommand`/`ProxyJump` (falla cerrado: no puede verificar la huella del servidor final). Decidir: soportar el proxy verificando la huella por ese mismo camino, o dejar la app solo por LAN/IP directa.
- [ ] **CLI sin `--context` usa la última conexión guardada** (`server01`), no el Docker local: un comando como `dockinng images pull` sin el flag puede actuar sobre el servidor sin avisar. Decidir: default local, o confirmación cuando la conexión activa es remota.
- [ ] Bundle de entrada: medido **352,94 kB** (no 305,29: creció con las funciones). La opción `experimentalMinChunkSize` no existe en Rolldown 1.2.10. Decidir: aceptar el tamaño o partir las páginas con carga diferida.
- [ ] Optimización: la mejora medida es la CPU en reposo (≈13 % → ≈0,3 % del hilo gráfico) y el binario (−8,4 %); la RAM (RSS/Pss) **no** bajó de forma demostrable. Sin medir: ventana sin foco, `stats` como stream único, features de tokio/bollard/tauri.
- [ ] Desborde a 420 px: corregido en las páginas nuevas; falta revisar el resto de páginas nuevas (ver Entrega wave4). Base UI puede dejar pasar el foco con Tab muy rápido (~10 ms) en el diálogo de confirmación tipeada.
- [ ] Menores pendientes de decisión: dos procesos DockInng simultáneos importan el legado dos veces (inocuo por dedupe) y el indicador `quiesced` vive en `ApiError` de `connection_select` (diseño documentado). Aceptar o cambiar. (Hecho en esta rama: nombres reservados de build y confianza `Trusted` cerrada ante rotación de una clave del mismo tipo.)
- [ ] La clave heredada `dockinng.groups.v1.migrated` (localStorage) no se borra hasta la Ola 3.

## Ola 1: pendientes tras la auditoría (rama `feature/wave1-stacks-terminal-images`)

- [ ] Prueba visual específica del cierre de ventana con operación en curso (up/pull) con Tauri/WebKitGTK real; la cascada de cierre ya está verificada por la suite `dockinng-app`.
- [ ] Riesgo aceptado: con `stack_create` + `run_stack_op(up)` con `privileged` o bind a `/` se obtiene root en el host sin ticket; la barrera real es la CSP y la ausencia de contenido remoto.
- [ ] Ventana TOCTOU residual: el chequeo de `include`/`extends`/`env_file` locales y el de `include` remotos ocurren antes de que Compose lea los archivos; un symlink cambiado en ese instante podría escapar. Cerrarla del todo requiere ejecutar Compose sobre una copia validada del proyecto (decisión de diseño pendiente: los `build:` con rutas relativas se romperían si solo se copian los YAML).
- [ ] Fragmento filtrado en el error de un archivo linked/descubierto inválido: **no reproducido** con Compose 5.5.1 (los errores de sintaxis, esquema, `include` roto e interpolación salen en una línea y no incluyen el contenido). Reabrir si aparece un caso real.
- [ ] Cerrar la terminal en un Docker REMOTO no mata el shell (el respaldo Ctrl-C + `exit` está sin probar; el `kill -HUP` por cgroup solo funciona con motor local).
- [ ] Sin verificar de extremo a extremo: xterm y CodeMirror en WebKitGTK real (portapapeles, teclado, rendimiento con salida masiva, lectores de pantalla); no hubo automatización de entrada/lectura AT-SPI. También siguen pendientes pull contra Docker Hub o registros con credenciales; Compose distinto de 5.5.1 y v1; estado `Warning` de `--progress json`; contenedor sin `/bin/sh`.
- [ ] La validación simulada de YAML (`lib/yamlCheck.ts`) es heurística (p. ej. `services: [` sin cerrar pasa); solo importa en el modo simulado, el real usa `docker compose config`.
- [ ] Los tests del editor y de la terminal usan CodeMirror/xterm simulados en jsdom; lo real solo se probó en Chromium con guiones fuera del repo.

## Grupos propios y consumo (rama `feature/containers-ux`)

- [ ] Los grupos no se sincronizan entre equipos (requiere un servicio compartido; exportar e importar un archivo ya están hechos).
- [ ] Consumo por grupo: solo cuentan los contenedores en marcha; el disco por grupo es aproximado (capas de escritura + volúmenes, sin imágenes) y Docker solo informa la capa de escritura de parte de los contenedores. GPU solo global (NVIDIA, motor local).

## Puertos (rama `feature/containers-ux`)

- [ ] El modal de puertos colapsa los rangos (≥ 3 consecutivos) y une IPv4/IPv6; no expande un rango a puertos sueltos. (Copiar y abrir ya están implementados en el modal y cubiertos por `ola3.ports.test.tsx`.)
- [ ] Los alias de DNS solo los da `inspect` (el listado no): la pestaña IPs los pide al abrirse (1 llamada); el modal de redes del grupo no los muestra. No hay IPs por proceso/puerto dentro del contenedor (Docker no lo informa; haría falta `exec`).

## Riesgos aceptados y decisiones abiertas
- [ ] Decisión propuesta: el cambio de conexión sigue esperando a las acciones en vuelo (intencional: una acción destructiva se ejecuta completa contra el motor en que se planificó; abortarla a mitad deja estado parcial). Confirmar o cambiar.
- [ ] Decisión propuesta: salir de Construir sigue cancelando la construcción (confirmado antes al usuario). Persistirla exige que el builder siga sin suscriptor y que la página vuelva a engancharse; cambio en el crate `builder`. Confirmar o cambiar.

- [ ] Un webview comprometido puede llamar a `plan_action` + `execute_action` con el texto de confirmación (no hay diálogo nativo). La barrera real es la CSP y la ausencia de contenido remoto. Reabrir si se carga contenido externo.
- [ ] Confirmar con el usuario: combinaciones de color, tono "bronce" de ámbar/naranja en claro, verde de estado "running" (matiz 128).
- [ ] Riesgo del nombre "DockInng": colisión con otros productos sin verificar.
- [ ] Decidir la base del PR: `develop` (13 commits detrás de `main`) o `main`.
- [ ] Commitear o guardar en stash los 35 archivos sin commitear de wave3/wave4 (ramas `feature/wave3-security`, `feature/wave4-security`, `feature/wave4-security-compose-hardening`, `feature/wave4-contracts`, `feature/wave4-frontend`). Bloqueado por permisos el 2026-10-05; pendiente de decisión del usuario.
- [ ] Commitear `quality-gate.yaml` y `scripts/dts-quality-gate.py` (sin `__pycache__`) en una rama propia, no en `main`.
- [ ] Integrar `feature/fix-layout-audit` en `develop` y luego en `main` (flujo del proyecto). Publicada en GitHub sin PR.

## Resuelto en revisión (2026-10-06)
- Reconexión del túnel: resuelta por diseño. Cada conexión HTTP lanza un `ssh` nuevo (`handle_connection`, `kill_on_drop`) y los streams de eventos se reconectan con espera creciente. Verificado en vivo contra `debian-dev`: cliente cortado a mitad, la siguiente operación responde en 241 ms. Queda sin reproducir solo un corte físico prolongado.

## Calidad y verificación

- [ ] **Parcialmente verificado:** la app real arrancó con `tauri dev` y con el binario extraído del `.deb`; IPC, permisos básicos, WebKitGTK y la UI cargaron. Falta la combinación empaquetado + navegación remota a `server01` (la captura mostró el contexto Local) y conservar esa evidencia.
- [ ] Probar en WebKitGTK real: `color-mix`/`oklch`, foco e `inert`, lectores de pantalla.
- [ ] Heurística TTY de bollard falla si la salida empieza con un byte de control ≤2 (caso raro).
- [ ] `time_nano` (i64) pierde precisión en JS por encima de 2^53; no se usa aún.

## Deuda técnica

- [ ] Licencia OFL de Geist junto a las fuentes (falta el texto oficial).
- [ ] Icono provisional (generado); diseñar el definitivo. `wordmark` convertido a trazos, revisar en producción.
- [ ] Falta `libayatana-appindicator` (solo necesario para tray).
- [ ] Mover lógica compartida a `services` cuando haya más de un adaptador (GUI + CLI).

## Entrega wave4 (pendiente de validación)

Detalle, matriz de hallazgos y evidencia en `docs/ENTREGA-WAVE4.md`.

- [ ] Live tests del backend (`DOCKINNG_LIVE_TESTS=1` y variables asociadas) no ejecutados; los tests ignorados siguen sin correr.
- [ ] Smoke test con Docker real sobre recursos `dockinng-dev-*` (puertos 54100-54110) no ejecutado.
- [ ] Tauri/WebKitGTK/AT-SPI y flujos interactivos o diálogos no ejecutados: tag accesible «No conectado aún», cierre con operación en curso, foco con Tab.
- [ ] Desborde a 420 px verificado solo en containers y stacks; revisar el resto de páginas nuevas.
- [ ] Origen del error del wrapper glob citado en el handoff: no aparece en ningún log disponible.
- [ ] Contrastar el rango 54100-54110 con la nota de Obsidian de nomenclatura y puertos (no localizada en esta sesión).
