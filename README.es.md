[English](README.md) | [Español](README.es.md)

# DockInng

Aplicación de escritorio nativa para Linux que administra Docker desde una interfaz gráfica, al estilo de Docker Desktop. Habla directo con la Docker Engine API. Una CLI complementaria (`dockinng`) comparte el mismo núcleo.

> Estado: en desarrollo. **Datos reales de Docker:** contenedores (listar, iniciar, detener, reiniciar, eliminar, eventos en vivo, logs, stats, inspect, terminal embebida, crear), imágenes (listar, eliminar, pull con progreso por capa), volúmenes y redes (listar, crear, eliminar) y stacks de Docker Compose (descubrir, up/down/reiniciar/detener/iniciar, progreso en vivo, editor de YAML y `.env` con validación, stacks propios y vinculados). **Aún simulado y marcado como "No conectado aún":** conexiones remotas SSH/TLS. Detalle en [PENDIENTES.md](PENDIENTES.md).

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Rust, tokio, [bollard](https://crates.io/crates/bollard), workspace de Cargo |
| Shell de escritorio | Tauri 2 |
| Frontend | React, TypeScript, Vite, shadcn/ui, Tailwind CSS (`pnpm`) |

## Estructura

```
backend/
  crates/engine-core     modelos de dominio, trait EngineClient, ConfirmationPolicy
  crates/engine-docker   adaptador de EngineClient sobre bollard
  crates/dockinng-cli    binario `dockinng` (clap)
  app/                   shell Tauri (comandos IPC)
frontend/                UI con React + Vite (shadcn/ui + Tailwind)
platilla-html/           referencia de diseño aprobada (libro de marca + plantilla HTML)
```

La GUI y la CLI son adaptadores del mismo núcleo; el frontend nunca habla con Docker directamente.

## Requisitos

Rust (stable), Node.js, `pnpm`, Docker y las dependencias de Tauri para Linux (WebKitGTK 4.1, GTK 3, librsvg). Tu usuario debe poder acceder al socket de Docker (grupo `docker`).

## Desarrollo

```bash
# Dependencias del frontend
pnpm --dir frontend install

# App de escritorio (levanta Vite y el shell Tauri)
pnpm --dir frontend tauri dev

# CLI
cd backend && cargo run -p dockinng-cli -- doctor
cd backend && cargo run -p dockinng-cli -- ps -a

# Tests
cd backend && cargo test
cd frontend && pnpm test && pnpm build && pnpm lint
```

## Apariencia

Configuración > Apariencia permite elegir modo claro, oscuro o sistema, un color de acento (presets o matiz personalizado), un tinte de superficies independiente y combinaciones con nombre. Los tokens se calculan en OKLCH y se validan con contraste WCAG AA en todos los matices. Los colores de estado y el logo no cambian con el acento.

## Stacks, terminal, pull y crear

- **Stacks:** los proyectos de Compose se descubren por sus etiquetas; también puedes crear los tuyos (se guardan en `~/.local/share/dockinng/stacks/`) o vincular un archivo compose existente. Levantar/reiniciar/detener/iniciar/actualizar muestran progreso en vivo y se pueden cancelar; *bajar* y *eliminar* exigen escribir el nombre del stack. Un stack creado fuera de la app es de solo lectura hasta que vincules su archivo.
- **Terminal:** un shell real dentro de un contenedor en marcha (xterm.js), con ajuste de tamaño, copiar/pegar y un aviso de riesgo si el contenedor es privilegiado o monta `docker.sock`. Cerrar la pestaña termina el shell.
- **Pull y crear:** el pull muestra el progreso por capa y sigue en segundo plano; crear un contenedor nunca hace pull por su cuenta (te lleva al pull si falta la imagen) y las opciones de riesgo (binds sensibles, `network=host`, `docker.sock`) piden confirmación.

## Puertos e IPs

La tabla de contenedores muestra solo los 2 puertos principales (primero los publicados, tcp antes que udp). El icono de ojo de cada fila abre un modal con dos pestañas: **Puertos** (todos los abiertos) e **IPs** (una fila por red con IPv4, IPv6, puerta de enlace, MAC y alias de DNS; un contenedor detenido conserva sus redes pero no tiene IP). En la pestaña Puertos: se unen los enlaces IPv4/IPv6 y las tiradas largas de puertos consecutivos se muestran como un rango (p. ej. `55110–55199/udp`).

## Grupos

Los contenedores se agrupan automáticamente por stack de Compose (cada stack tiene su color). La cabecera del grupo tiene un botón **Redes** con el número de redes y un ojo que abre un modal con cada red (driver, subred, puerta de enlace) y los contenedores del grupo conectados a ella con sus IPs; las redes del sistema (bridge, host, none) se omiten. También puedes crear tus propios grupos (menú de cada fila o barra masiva), elegir cualquier color para un grupo o un stack y gestionarlos en Configuración > Grupos. Los grupos propios se guardan solo en la app, por conexión, y no cambian nada en Docker.

La Configuración está dividida en pestañas: Conexiones, Apariencia, Grupos, Seguridad y Datos.

## Seguridad

Las acciones destructivas pasan por una `ConfirmationPolicy` en el núcleo: las reversibles se ejecutan directo, las destructivas piden confirmación, y hay un piso de acciones catastróficas que ni `--yes` puede saltar. Sin TTY, todo lo que requiera confirmación se deniega. En la app de escritorio, las acciones destructivas siguen un flujo plan → ticket de un solo uso → confirmación escrita que hace cumplir el backend (las de un único objetivo exigen el nombre exacto; los prunes exigen la palabra `ELIMINAR`). Riesgo aceptado y conocido: un webview comprometido aún podría llamar a los comandos de plan/ejecución, así que la CSP estricta y la ausencia de contenido remoto son la barrera real.
