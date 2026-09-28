[English](README.md) | [Español](README.es.md)

# DockInng

A native Linux desktop app to manage Docker from a graphical interface, in the spirit of Docker Desktop. It talks directly to the Docker Engine API. A companion CLI (`dockinng`) shares the same core.

> Status: in development. **Real Docker data:** containers (list, start, stop, restart, remove, live events, logs, stats, inspect, embedded terminal, create), images (list, remove, pull with per-layer progress), volumes and networks (list, create, remove), and Docker Compose stacks (discover, up/down/restart/stop/start, live progress, YAML and `.env` editor with validation, own and linked stacks). **Also real:** remote engines over SSH or TLS with a context selector, registry credentials in the system keyring, image builds, guided cleanup, a SQLite store for groups and preferences, and a much wider CLI. Podman is detected only. Details in [PENDIENTES.md](PENDIENTES.md).

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

## Installation

Packages are built from source; no prebuilt releases yet.

```bash
# Debian / Ubuntu (.deb) and Fedora / openSUSE (.rpm)
pnpm --dir frontend install
cd backend/app && ../../frontend/node_modules/.bin/tauri build --bundles deb,rpm
# Output: backend/target/release/bundle/{deb,rpm}/
sudo apt install ./dockinng_0.1.0_amd64.deb    # or: sudo dnf install ./dockinng-0.1.0-1.x86_64.rpm

# Arch Linux
cd backend/app/packaging/arch && makepkg -si
```

The `.deb`/`.rpm` contain the desktop app (`dockinng-app`). The `dockinng` CLI is installed by the Arch package; on other distributions build it with `cd backend && cargo install --path crates/dockinng-cli`. Runtime dependencies: WebKitGTK 4.1, GTK 3 and libayatana-appindicator (system tray). Licenses: [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

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

## Remote connections, registries, builds and cleanup

- **Remote engines:** connect over SSH (through a private tunnel that runs `docker system dial-stdio`) or TLS. SSH always uses strict host key checking with DockInng's own `known_hosts`: the first connection shows the fingerprint and asks you to trust it, and a changed key is blocked with no way to accept it from the app. DockInng never stores or copies private keys, only their paths (or uses your ssh-agent).
- **Registries:** credentials live in the system keyring (Secret Service), never in the database or in `~/.docker/config.json`.
- **Builds and cleanup:** image builds run through `docker build` (sensitive contexts need confirmation). Guided cleanup only *plans* what could be removed, with an estimate of the space, and every removal goes through a confirmation ticket; nothing is ever pruned blindly.
- **CLI:** `dockinng` covers containers, images, volumes, networks, logs, stacks, cleanup and shell `completions`, with the same confirmation policy as the app (`--yes` never skips typed confirmations).

## Ports and IPs

The container table shows only the 2 main ports (published first, tcp before udp). The eye icon on every row opens a dialog with two tabs: **Ports** (all open ports) and **IPs** (one row per network with IPv4, IPv6, gateway, MAC and DNS aliases; stopped containers keep their networks but have no IP). In the Ports tab: IPv4/IPv6 bindings are merged and long runs of consecutive ports are shown as a range (e.g. `55110–55199/udp`).

## Groups

Containers are grouped by Compose stack automatically (each stack gets its own color). The group header has a **Networks** button with the number of networks and an eye that opens a dialog with each network (driver, subnet, gateway) and the group's containers connected to it with their IPs; system networks (bridge, host, none) are omitted. You can also create your own groups (menu on each row, or the bulk bar), pick any color for a group or a stack, and manage them in Settings > Groups. Custom groups are stored only in the app, per connection, and never change anything in Docker.

Settings is split into tabs: Connections, Appearance, Groups, Security and Data.

## Safety

Destructive actions go through a `ConfirmationPolicy` in the core: reversible actions run directly, destructive ones ask for confirmation, and there is a floor of catastrophic actions that not even `--yes` can bypass. Without a TTY, anything that needs confirmation is denied. In the desktop app, destructive actions use a plan → one-time ticket → typed confirmation flow enforced by the backend (single-target actions require the exact name; prunes require the word `ELIMINAR`). Known accepted risk: a compromised webview could still call the plan/execute commands, so the strict CSP and the absence of remote content are the real barrier.
