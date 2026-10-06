# Pendientes — DockInng

Ver detalle y contexto en Obsidian: `Proyectos/DockInng/DockInng - Pendientes.md`, `DockInng - Estado actual y reconciliación.md` y el historial en `DockInng - Bitácora.md`.

Lo ya cerrado se retiró de esta lista (2026-10-06); su historial está en la Bitácora de Obsidian.

## Ola 3: empaquetado

- [ ] Pasar `rpmlint` sin errores al RPM generado por Tauri: verificado en Fedora 44 con `rpmlint 2.8.0`; quedan 9 errores y 2 advertencias por documentación no marcada como `%doc`, `no-documentation`, `no-changelogname-tag`, `no-buildhost-tag` y nombre de archivo no coherente. El paquete instala/desinstala correctamente; documentar o corregir según lo que controle Tauri.
- [ ] Build completo del PKGBUILD con red (`pnpm install`, `cargo fetch`), con tag `v0.1.0` publicado y `updpkgsums`; `namcap` no reportó problemas, pero el tag todavía no existe en GitHub y `makepkg --verifysource` devuelve 404.
- [ ] Bandeja en Plasma: comprobar `tray.png` sobre paneles claro y oscuro, y `StartupWMClass=dockinng-app` en Wayland.
- [ ] Revisar si `backend/app/Cargo.toml` debe heredar `authors`/`description` del workspace; actualmente queda fuera de alcance.
- [ ] Copia del RPM compatible con Leap a la ruta canónica (`backend/target-leap/...`): requiere `sudo` porque el directorio pertenece a `root`.

## Ola 2: pendientes tras la auditoría (rama `feature/wave2-persistence-remote`)

- [ ] **Parcialmente verificado con servidor real:** `live_real_ssh` pasó de nuevo el 2026-10-06 contra `debian-dev` (server01, solo lectura: ping 854 ms, info 195 ms, corte y reconexión 241 ms sin hijos residuales). Siguen sin verificar: Docker rootless (server01 es rootful, Docker 29.6.2); ProxyJump/alias complejos con TOFU (cubierto por test unitario `alias_con_proxy_falla_cerrado`, no en vivo); cortes físicos prolongados; dockerd con TLS real (requiere cambiar la config del daemon en server01). Las dos últimas exigen confirmación explícita antes de tocar el servidor.
- [ ] **Builds:** se fuerza `BUILDKIT_PROGRESS=plain` para poder auditar la salida, pero la interfaz actual todavía envía `--build-arg`; los valores marcados como secreto solo generan confirmación y siguen quedando visibles en `docker history` si el daemon usa el builder clásico. Para secretos reales debe usarse un Dockerfile con `RUN --mount=type=secret` y `docker build --secret`; no se implementa una fuente de secretos en esta versión. El borrado de la caché de build por elemento no está implementado; el parser de progreso es frágil entre versiones (se muestran siempre las líneas crudas).
- [ ] **Conexiones:** reconexión automática del túnel tras un corte largo (hoy el proceso `ssh` no se vigila ni se relanza; solo se reconectan los streams de eventos). Olvidar huella cambiada (hecho, con confirmación en el backend) falta verificarla en WebKitGTK real. Resto de notas: ControlMaster se mantiene desactivado deliberadamente para no compartir sockets; los alias SSH se resuelven solo bajo gesto explícito y se rechazan si `ssh -G` informa `ProxyJump`/`ProxyCommand`, porque no puede verificarse de forma fiable la huella del destino final. Las rutas TLS deben ser archivos regulares sin symlink, de dueño root/usuario actual; la llave además exige `0600`. Un `DOCKER_HOST=tcp://...` heredado se ignora: TCP remoto solo se habilita mediante el perfil TLS explícito.
- [ ] **Acceso remoto por túnel de Cloudflare desde la app:** `ssh debian-remote` funciona por consola (verificado 2026-10-06 con `ProxyCommand cloudflared access ssh --hostname %h` y huella igual a la LAN), pero DockInng rechaza los alias con `ProxyCommand`/`ProxyJump` (falla cerrado: no puede verificar la huella del servidor final). Decidir: soportar el proxy verificando la huella por ese mismo camino, o dejar la app solo por LAN/IP directa.
- [ ] **CLI sin `--context` usa la última conexión guardada** (`server01`), no el Docker local: un comando como `dockinng images pull` sin el flag puede actuar sobre el servidor sin avisar. Decidir: default local, o confirmación cuando la conexión activa es remota.
- [ ] Cambiar de conexión espera a que terminen las acciones en vuelo (`RwLock`); un cambio puede tardar lo que dure una acción larga. Alternativa: generación con aborto inmediato (toca `ActionService`).
- [ ] Build: el estado del build no persiste entre navegaciones (salir de Construir con un build en curso ya pide confirmación y cancela el canal).
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
- [ ] Falsos positivos del pre-escaneo de `include`: un YAML válido que `serde_norway` no lea se rechaza como «no verificable» (falla cerrado). Revisar con casos reales de YAML poco común y, si aparecen, ajustar el parser o la regla.
- [ ] `cargo fmt --all` modifica `crates/dockinng-cli/src/output.rs`: el archivo ya estaba sin formato en `develop`. Formatearlo en una rama propia para que `cargo fmt --check` pase.
- [ ] Cerrar la terminal en un Docker REMOTO no mata el shell (el respaldo Ctrl-C + `exit` está sin probar; el `kill -HUP` por cgroup solo funciona con motor local).
- [ ] Sin verificar de extremo a extremo: xterm y CodeMirror en WebKitGTK real (portapapeles, teclado, rendimiento con salida masiva, lectores de pantalla); no hubo automatización de entrada/lectura AT-SPI. También siguen pendientes pull contra Docker Hub o registros con credenciales; Compose distinto de 5.5.1 y v1; estado `Warning` de `--progress json`; contenedor sin `/bin/sh`.
- [ ] La validación simulada de YAML (`lib/yamlCheck.ts`) es heurística (p. ej. `services: [` sin cerrar pasa); solo importa en el modo simulado, el real usa `docker compose config`.
- [ ] Los tests del editor y de la terminal usan CodeMirror/xterm simulados en jsdom; lo real solo se probó en Chromium con guiones fuera del repo.

## Grupos propios y consumo (rama `feature/containers-ux`)

- [ ] Los grupos propios y los colores de stack ya viven en el almacén SQLite (Ola 2); no se sincronizan entre equipos ni se exportan.
- [ ] Asignar arrastrando filas a una cabecera de grupo (hoy: menú de la fila o barra masiva).
- [ ] Las asignaciones de contenedores que ya no existen no se limpian (quedan inertes en el almacenamiento).
- [ ] Consumo por grupo: solo cuentan los contenedores en marcha; el disco por grupo es aproximado (capas de escritura + volúmenes, sin imágenes) y Docker solo informa la capa de escritura de parte de los contenedores. GPU solo global (NVIDIA, motor local).

## Puertos (rama `feature/containers-ux`)

- [ ] El modal de puertos muestra rangos colapsados (≥ 3 consecutivos) y une IPv4/IPv6; no expande un rango a puertos sueltos ni permite copiar/abrir un puerto en el navegador.
- [ ] Los alias de DNS solo los da `inspect` (el listado no): la pestaña IPs los pide al abrirse (1 llamada); el modal de redes del grupo no los muestra. No hay IPs por proceso/puerto dentro del contenedor (Docker no lo informa; haría falta `exec`).
- [ ] La línea de puertos de la vista Stacks (simulada) sigue mostrando el texto completo.

## Riesgos aceptados y decisiones abiertas

- [ ] Un webview comprometido puede llamar a `plan_action` + `execute_action` con el texto de confirmación (no hay diálogo nativo). La barrera real es la CSP y la ausencia de contenido remoto. Reabrir si se carga contenido externo.
- [ ] Confirmar con el usuario: combinaciones de color, tono "bronce" de ámbar/naranja en claro, verde de estado "running" (matiz 128).
- [ ] Riesgo del nombre "DockInng": colisión con otros productos sin verificar.
- [ ] Decidir la base del PR: `develop` (13 commits detrás de `main`) o `main`.
- [ ] Commitear o guardar en stash los 35 archivos sin commitear de wave3/wave4 (ramas `feature/wave3-security`, `feature/wave4-security`, `feature/wave4-security-compose-hardening`, `feature/wave4-contracts`, `feature/wave4-frontend`). Bloqueado por permisos el 2026-10-05; pendiente de decisión del usuario.
- [ ] Commitear `quality-gate.yaml` y `scripts/dts-quality-gate.py` (sin `__pycache__`) en una rama propia, no en `main`.
- [ ] Integrar `feature/fix-layout-audit` en `develop` y luego en `main` (flujo del proyecto). Publicada en GitHub sin PR.
- [ ] Reconciliar los commits citados en las notas con el historial real (`43968de`, `2ca8b81`, `6f3c3ee`, `372d906`, `7b494a9` no existen en el repo).

## Calidad y verificación

- [ ] **Parcialmente verificado:** la app real arrancó con `tauri dev` y con el binario extraído del `.deb`; IPC, permisos básicos, WebKitGTK y la UI cargaron. Falta la combinación empaquetado + navegación remota a `server01` (la captura mostró el contexto Local) y conservar esa evidencia.
- [ ] Probar en WebKitGTK real: `color-mix`/`oklch`, foco e `inert`, lectores de pantalla.
- [ ] Heurística TTY de bollard falla si la salida empieza con un byte de control ≤2 (caso raro).
- [ ] `time_nano` (i64) pierde precisión en JS por encima de 2^53; no se usa aún.
- [ ] `pnpm test` falló una vez con «Errors 1 error» (vitest, sin fallo de tests: 738/738) y no se reprodujo en 3 corridas seguidas; vigilar si reaparece.

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
