// Manifest de permisos de la app: cada comando propio exige el permiso `allow-<comando>`
// (con guiones) declarado en `capabilities/default.json`. Mínimo privilegio.
include!("src/command_names.rs");

fn main() {
    // El icono monocromo de la bandeja es opcional: si existe se incluye en el binario.
    println!("cargo::rustc-check-cfg=cfg(has_tray_png)");
    println!("cargo::rerun-if-changed=icons/tray.png");
    if std::path::Path::new("icons/tray.png").is_file() {
        println!("cargo::rustc-cfg=has_tray_png");
    }

    let manifest = tauri_build::AppManifest::new().commands(COMMAND_NAMES);
    let attrs = tauri_build::Attributes::new().app_manifest(manifest);
    if let Err(e) = tauri_build::try_build(attrs) {
        // Error de configuración en tiempo de compilación: se muestra y se aborta el build.
        eprintln!("error de tauri-build: {e:#}");
        std::process::exit(1);
    }
}
