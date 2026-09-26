[English](README.md) | [Español](README.es.md)

# DockInng

A native Linux desktop app to manage Docker from a graphical interface, in the spirit of Docker Desktop. It talks directly to the Docker Engine API. A companion CLI (`dockinng`) shares the same core.

> Status: in development. **Real Docker data:** containers (list, start, stop, restart, remove, live events, logs, stats, inspect, embedded terminal, create), images (list, remove, pull with per-layer progress), volumes and networks (list, create, remove), and Docker Compose stacks (discover, up/down/restart/stop/start, live progress, YAML and `.env` editor with validation, own and linked stacks). **Still simulated and marked "Not connected yet":** SSH/TLS remote connections. Details in [PENDIENTES.md](PENDIENTES.md).

## Stack

| Layer | Technology |
|---|---|
| Backend | Rust, tokio, [bollard](https://crates.io/crates/bollard), Cargo workspace |
| Desktop shell | Tauri 2 |
| Frontend | React, TypeScript, Vite, shadcn/ui, Tailwind CSS (`pnpm`) |

## Layout

```
backend/
  crates/engine-core     domain models, EngineClient trait, ConfirmationPolicy
  crates/engine-docker   EngineClient adapter on top of bollard
  crates/dockinng-cli    `dockinng` binary (clap)
  app/                   Tauri shell (IPC commands)
frontend/                React + Vite UI (shadcn/ui + Tailwind)
platilla-html/           approved design reference (brand book + HTML template)
```

The GUI and the CLI are adapters over the same core; the frontend never talks to Docker directly.

## Requirements

Rust (stable), Node.js, `pnpm`, Docker, and the Tauri Linux dependencies (WebKitGTK 4.1, GTK 3, librsvg). Your user must be able to access the Docker socket (group `docker`).

## Development

```bash
# Frontend deps
pnpm --dir frontend install

# Desktop app (starts Vite and the Tauri shell)
pnpm --dir frontend tauri dev

# CLI
cd backend && cargo run -p dockinng-cli -- doctor
cd backend && cargo run -p dockinng-cli -- ps -a

# Tests
cd backend && cargo test
cd frontend && pnpm test && pnpm build && pnpm lint
```

## Appearance

Settings > Appearance lets you pick light, dark or system mode, an accent color (presets or a custom hue), an independent surface tint and named combinations. Tokens are computed in OKLCH and validated for WCAG AA contrast across all hues. Status colors and the logo do not change with the accent.

## Stacks, terminal, pull and create

- **Stacks:** Compose projects are discovered by their labels; you can also create your own (stored in `~/.local/share/dockinng/stacks/`) or link an existing compose file. Up/restart/stop/start/pull show live progress and can be cancelled; *down* and *delete* need you to type the stack name. A stack created outside the app is read-only until you link its file.
- **Terminal:** a real shell inside a running container (xterm.js), with resize, copy/paste and a risk banner for privileged containers or ones that mount `docker.sock`. Closing the tab ends the shell.
- **Pull and create:** pull shows per-layer progress and keeps running in the background; creating a container never pulls by itself (it sends you to Pull when the image is missing), and risky choices (sensitive bind mounts, `network=host`, `docker.sock`) need a confirmation.

## Ports and IPs

The container table shows only the 2 main ports (published first, tcp before udp). The eye icon on every row opens a dialog with two tabs: **Ports** (all open ports) and **IPs** (one row per network with IPv4, IPv6, gateway, MAC and DNS aliases; stopped containers keep their networks but have no IP). In the Ports tab: IPv4/IPv6 bindings are merged and long runs of consecutive ports are shown as a range (e.g. `55110–55199/udp`).

## Groups

Containers are grouped by Compose stack automatically (each stack gets its own color). The group header has a **Networks** button with the number of networks and an eye that opens a dialog with each network (driver, subnet, gateway) and the group's containers connected to it with their IPs; system networks (bridge, host, none) are omitted. You can also create your own groups (menu on each row, or the bulk bar), pick any color for a group or a stack, and manage them in Settings > Groups. Custom groups are stored only in the app, per connection, and never change anything in Docker.

Settings is split into tabs: Connections, Appearance, Groups, Security and Data.

## Safety

Destructive actions go through a `ConfirmationPolicy` in the core: reversible actions run directly, destructive ones ask for confirmation, and there is a floor of catastrophic actions that not even `--yes` can bypass. Without a TTY, anything that needs confirmation is denied. In the desktop app, destructive actions use a plan → one-time ticket → typed confirmation flow enforced by the backend (single-target actions require the exact name; prunes require the word `ELIMINAR`). Known accepted risk: a compromised webview could still call the plan/execute commands, so the strict CSP and the absence of remote content are the real barrier.
