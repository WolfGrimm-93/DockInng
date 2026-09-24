// Evita abrir una consola extra en Windows en release (no afecta a Linux).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dockinng_app_lib::run()
}
