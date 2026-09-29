# Pendientes — DockInng

Ver detalle y contexto en Obsidian: `Proyectos/DockInng/DockInng - Lista de trabajo.md` y `DockInng - Pendientes.md`.

## Simulado en la UI
- Nada queda simulado contra Docker. Podman solo se **detecta** (no se puede guardar una conexión Podman: el contrato solo admite `ssh` y `tls`).

## Ola 3: empaquetado (parcialmente verificado)

- [x] Reconstruir el `.deb` con `tauri build --bundles deb` y validar su contenido, control, desktop entry e iconos; `dpkg-deb`, `lintian`, `rpm` y `rpmlint` no están instalados aquí.
- [x] Instalar el `.deb` en una imagen Debian 13 limpia, verificar instalación con `dpkg`, validar el desktop entry y ejecutar `lintian` sin errores.
- [x] Construir el RPM real con `tauri bundle --bundles rpm` dentro de Fedora 44; instalarlo y desinstalarlo con `dnf` pasó correctamente.
- [ ] Pasar `rpmlint` sin errores al RPM generado por Tauri: el paquete funciona, pero el bundler no emite etiquetas de changelog/buildhost ni marca los archivos como `%doc`.
- [x] Confirmar las dependencias RPM detectadas en Fedora 44 (`webkit2gtk4.1`, `gtk3` y `libappindicator-gtk3`/`libappindicator3.so.1`).
- [ ] Confirmar las equivalencias de dependencias en openSUSE.
- [ ] Build completo del PKGBUILD con red (`pnpm install`, `cargo fetch`), con tag `v0.1.0` publicado y `updpkgsums`; `namcap` no reportó problemas, pero el tag todavía no existe en GitHub y `makepkg --verifysource` devuelve 404.
- [x] Confirmar que el CLI `dockinng` no se incluye en el deb/rpm y queda reservado para el PKGBUILD.
- [x] Mantener AppImage descartado: descarga herramientas y el WebKitGTK empaquetado da problemas en Wayland.
- [ ] Bandeja en Plasma: comprobar `tray.png` sobre paneles claro y oscuro, y `StartupWMClass=dockinng-app` en Wayland.
- [ ] Revisar si `backend/app/Cargo.toml` debe heredar `authors`/`description` del workspace; actualmente queda fuera de alcance.

## Ola 2: pendientes tras la auditoría (rama `feature/wave2-persistence-remote`)
- [ ] **Parcialmente verificado con servidor real:** SSH/Docker remoto contra el alias LAN `debian-dev` (`10.0.0.17`): PATH no interactivo, banner, latencia, corte del cliente y reconexión pasaron en `live_real_ssh`; también se redujo la detección de cortes a 5 s × 2 sondas, se clasifican passphrases sin agente como `auth_failed`, se endureció el borrado seguro de `known_hosts` y el parseo de alias con espacios/tabulaciones. Siguen pendientes rootless, ProxyJump/alias complejos con TOFU (falla cerrado), cortes físicos prolongados y dockerd con TLS real. Las llaves con passphrase sin agente siguen sin prompt por diseño.
- [x] Prueba live real `transport/tests/live_real_ssh.rs`: verificada el 29 de septiembre de 2026 contra `debian-dev`, solo lectura y con known_hosts temporal; no modifica servicios ni contenedores remotos.
- [x] Llavero real Secret Service verificado el 29 de septiembre de 2026 en una sesión Debian 13 aislada con `dbus-run-session` + `gnome-keyring-daemon --unlock`; la entrada es desechable y se elimina aun si el test falla.
- [x] Pull autenticado verificado el 29 de septiembre de 2026 contra un `registry:2` local aislado, con credenciales generadas por ejecución, Docker config temporal y limpieza posterior.
- [x] `--context` global y `context add ssh|tls`, `context use`, `context ls` y `context rm` implementados; las pruebas cubren selección persistida, alias, JSON, no exposición de secretos y denegación sin TTY.
- [ ] Confirmación en TTY real de la CLI solo probada con simulador; Ctrl-C real en `logs -f`/`pull` sigue pendiente.
- [ ] Builds: solo builder clásico (no hay `buildx`); el valor de un build-arg secreto queda visible en `docker history` con el builder clásico; el borrado de la caché de build por elemento no está implementado; el parser de progreso es frágil entre versiones (se muestran siempre las líneas crudas).
- [ ] Conexiones: edición de conexiones guardadas desde la UI, conservando el `id` y usando `connection_save {id}`; verificado con test simulado de renombrado y suite frontend. Pendientes: no hay comando ni UI para **olvidar** una huella cambiada (hoy hay que editar el `known_hosts` propio de DockInng); reconexión automática del túnel tras un corte largo; ControlMaster se mantiene desactivado deliberadamente para no compartir sockets; avisar si una llave TLS tiene permisos abiertos.
- [ ] Cambiar de conexión espera a que terminen las acciones en vuelo (`RwLock`); un cambio puede tardar lo que dure una acción larga. Alternativa: generación con aborto inmediato (toca `ActionService`).
- [x] Salir de la página Construir con un build en curso pide confirmación y cancela el canal al abandonar; verificado en `ola2.ui.test.tsx`. Pendiente separado: el build no persiste entre navegaciones.
- [ ] Bundle de entrada 305,29 kB (+16 kB sobre la Ola 1) por la recolocación de chunks de Rollup; revisar `experimentalMinChunkSize`.
- [ ] Optimización: la mejora medida es la CPU en reposo (≈13 % → ≈0,3 % del hilo gráfico) y el binario (−8,4 %); la RAM (RSS/Pss) **no** bajó de forma demostrable. Sin medir: ventana sin foco, `stats` como stream único, features de tokio/bollard/tauri.
- [ ] Desborde interno a 420 px en las páginas nuevas (la ventana tiene `minWidth` 900, no es alcanzable); Base UI puede dejar pasar el foco con Tab muy rápido (~10 ms) en el diálogo de confirmación tipeada.
- [ ] Menores: `reserved_arg_name` no cubre `SSL_CERT_FILE`/`TMPDIR`/`GODEBUG`; dos procesos DockInng simultáneos podrían importar el legado dos veces (inocuo por dedupe); en modo `Trusted`, si un servidor rota solo su clave ed25519 la UI puede decir «trusted» aunque `ssh` falle cerrado; `ConnectionStatus.failed.quiesced` existe en TS y Rust nunca lo envía.
- [ ] La clave heredada `dockinng.groups.v1.migrated` (localStorage) no se borra hasta la Ola 3.

## Ola 1: pendientes tras la auditoría (rama `feature/wave1-stacks-terminal-images`)
- [x] **Cerrar la ventana con una operación en curso** (up/pull): el cierre backend aborta primero las tareas supervisadas y después terminales/túneles, evitando dejar procesos Compose huérfanos; verificado por la suite `dockinng-app` (incluye cascada de cierre y ausencia de huérfanos). Pendiente una prueba visual específica con Tauri/WebKitGTK real.
- [x] «Abrir archivo Compose» tiene selector nativo de archivos Compose (`tauri-plugin-dialog` + permiso `dialog:allow-open`); la ruta absoluta escrita sigue disponible como alternativa.
- [ ] Riesgo aceptado: con `stack_create` + `run_stack_op(up)` con `privileged` o bind a `/` se obtiene root en el host sin ticket; la barrera real es la CSP y la ausencia de contenido remoto.
- [ ] El pre-escaneo de `include` remoto (git/oci/http/ssh) es de mejor esfuerzo por líneas: un YAML muy retorcido podría evadirlo. `include`/`extends`/`env_file` locales que salgan del directorio del stack no se restringen. Sin test del tope de 2 validaciones simultáneas.
- [ ] Un fallo de un archivo linked/descubierto inválido puede filtrar un fragmento en el mensaje de error de Compose (truncado a 2 KiB y con los valores del `.env` ocultos).
- [ ] Cerrar la terminal en un Docker REMOTO no mata el shell (el respaldo Ctrl-C + `exit` está sin probar; el `kill -HUP` por cgroup solo funciona con motor local).
- [ ] Sin verificar de extremo a extremo: xterm y CodeMirror en WebKitGTK real (portapapeles, teclado, rendimiento con salida masiva, lectores de pantalla); en esta máquina sí se hizo arranque `tauri dev` + inspección visual nativa, pero no hubo automatización de entrada/lectura AT-SPI para completar esos flujos. También siguen pendientes pull contra Docker Hub o registros con credenciales; Compose distinto de 5.5.1 y v1; estado `Warning` de `--progress json`; contenedor sin `/bin/sh`.
- [x] Pruebas live contra Docker local verificadas el 28 de septiembre de 2026: ciclo de vida, diagnóstico, endpoints, estadísticas, eventos, logs, planificación/ejecución, creación, `exec`, resize, pull por capas y cancelación, volúmenes, redes, Compose y TLS mTLS pasaron. El pull live utilizó el registro local en `127.0.0.1:54109`.
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
- [ ] La vista de Redes no usa puertos (no aplica); la línea de puertos de la vista Stacks (simulada) sigue mostrando el texto completo.

## Riesgos aceptados y decisiones abiertas
- [ ] Un webview comprometido puede llamar a `plan_action` + `execute_action` con el texto de confirmación (no hay diálogo nativo). La barrera real es la CSP y la ausencia de contenido remoto. Reabrir si se carga contenido externo.
- [ ] Confirmar con el usuario: combinaciones de color, tono "bronce" de ámbar/naranja en claro, verde de estado "running" (matiz 128).
- [ ] Riesgo del nombre "DockInng": colisión con otros productos sin verificar.

## Calidad y verificación
- [ ] Verificar la app real con `tauri dev` (IPC, permisos sin `core:default`, CSP) y con `tauri build` (hash del script inline de prepaint).
- [ ] Probar en WebKitGTK real: `color-mix`/`oklch`, foco e `inert`, lectores de pantalla.
- [ ] Test de contrato IPC generado desde Rust (hoy los fixtures TS son manuales y solo `tsc` detecta deriva).
- [x] Prunes reales de imágenes/volúmenes/redes verificados contra Docker local mediante `live_cleanup` el 28 de septiembre de 2026.
- [x] Reconexión con el daemon real verificada en el ciclo live local; la reconexión SSH tras cortes prolongados sigue pendiente.
- [ ] Heurística TTY de bollard falla si la salida empieza con un byte de control ≤2 (caso raro).
- [ ] `time_nano` (i64) pierde precisión en JS por encima de 2^53; no se usa aún.

## Deuda técnica
- [ ] 11 avisos de oxlint `only-export-components` (fast refresh) en archivos de componentes compartidos.
- [ ] Licencia OFL de Geist junto a las fuentes (falta el texto oficial).
- [ ] Icono provisional (generado); diseñar el definitivo. `wordmark` convertido a trazos, revisar en producción.
- [ ] Falta `libayatana-appindicator` (solo necesario para tray).
- [ ] Mover lógica compartida a `services` cuando haya más de un adaptador (GUI + CLI).

## Hecho (esta rama)
- [x] **Ola 2:** crate `store` (SQLite, UUID v7) con migración de grupos desde localStorage y preferencias; conexiones SSH/TLS con selector de contexto (túnel propio, clave de host estricta con TOFU explícito, TLS verificado) y Compose/builds sobre remoto; registros con credenciales en el llavero; CLI ampliada (imágenes, volúmenes, redes, logs, stacks, limpieza, completions); builds de imagen; limpieza guiada por tickets; detección de Podman; aviso de binds relativos en remoto; optimización de stats, animaciones y perfil de release.
- [x] **Ola 1:** stacks Compose reales (descubrir, up/down/restart/stop/start/pull con progreso y cancelación, editor YAML/`.env` con validación, propios/vinculados/descubiertos, bajar y eliminar con nombre), terminal exec real con xterm, pull con progreso por capa, crear contenedor real con confirmación de riesgos y elección de grupo, nuevo volumen y nueva red.
- [x] Diseño completo implementado, sidebar flotante, temas y personalización de color.
- [x] Contenedores reales: listar, iniciar, detener, reiniciar, eliminar, eventos, logs, stats, inspect.
- [x] Imágenes, volúmenes y redes reales: listar y eliminar.
- [x] `ConfirmationPolicy` ampliada con tickets, confirmación escrita y aplicación en el backend.
- [x] Diagnóstico de conexión (socket ausente, permisos, daemon apagado) y reconexión.
