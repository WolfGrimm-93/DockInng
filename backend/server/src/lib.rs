//! `dockinng-server`: adaptador HTTP del núcleo de DockInng (igual que `dockinng-cli` y la
//! app de escritorio, pero expuesto por red). Ver `PENDIENTES.md` por lo que falta: streaming
//! (logs/stats/terminal), acciones destructivas, cliente web y containerización.

pub mod auth;
pub mod config;
pub mod containers;
pub mod credentials;
mod cookie;
pub mod error;
pub mod login_limit;
pub mod session;
pub mod state;
pub mod users_admin;

use std::sync::Arc;

use axum::Router;
use axum::routing::{delete, get, patch, post, put};
use engine_core::Role;
use engine_docker::{DockerEngine, Target};
use store::Store;

pub use config::{AuthMode, Config};
pub use state::AppState;

use session::SessionStore;

pub fn build_router(state: &AppState) -> Router<AppState> {
    let mut app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/containers", get(containers::list_containers));

    if state.store.is_some() {
        app = app
            .route(
                "/api/users",
                get(users_admin::list_users).post(users_admin::create_user),
            )
            .route("/api/users/{id}/role", patch(users_admin::set_role))
            .route("/api/users/{id}/password", put(users_admin::set_password))
            .route("/api/users/{id}", delete(users_admin::delete_user));
    }

    app
}

/// Abre el almacén y, si no hay ningún usuario, crea el administrador inicial a partir de
/// `DOCKINNG_BOOTSTRAP_ADMIN_USER`/`_PASSWORD`. Sin esas variables el servidor arranca igual,
/// pero nadie va a poder entrar hasta que se cree un usuario a mano.
pub fn open_store_and_bootstrap(config: &Config) -> Store {
    let store = Store::open_default().unwrap_or_else(|e| {
        eprintln!("no se pudo abrir el almacén: {e}");
        std::process::exit(1);
    });
    let count = store.user_count().unwrap_or_else(|e| {
        eprintln!("no se pudo contar los usuarios: {e}");
        std::process::exit(1);
    });
    if count == 0 {
        match &config.bootstrap_admin {
            Some((username, password)) => {
                // Mismas reglas que al crear usuarios por la API: un admin inicial débil o con
                // un nombre engañoso sería la cuenta más valiosa del sistema.
                if let Err(e) = credentials::validate_username(username)
                    .and_then(|()| credentials::validate_password(password))
                {
                    eprintln!("DOCKINNG_BOOTSTRAP_ADMIN_USER/_PASSWORD inválidos: {e}");
                    std::process::exit(1);
                }
                let hash = store::password::hash_password(password)
                    .expect("hash del administrador inicial");
                store
                    .user_create(username, &hash, Role::Admin)
                    .expect("crear el administrador inicial");
                eprintln!("administrador inicial «{username}» creado");
            }
            None => eprintln!(
                "aviso: no hay usuarios y no se definieron DOCKINNG_BOOTSTRAP_ADMIN_USER/\
                 DOCKINNG_BOOTSTRAP_ADMIN_PASSWORD; nadie podrá entrar hasta crear uno"
            ),
        }
    }
    store
}

/// Arma el estado inicial del servidor (motor local + almacén si corresponde) a partir de la
/// configuración. Separado de `run` para poder armar el mismo estado en los tests de
/// integración sin levantar un socket real.
pub fn build_state(config: &Config) -> AppState {
    let store = match config.auth_mode {
        AuthMode::Multi => Some(Arc::new(open_store_and_bootstrap(config))),
        AuthMode::Single => None,
    };

    let docker = Arc::new(DockerEngine::new());
    docker.set_target(Target::local());
    let engine: Arc<dyn engine_core::EngineClient> = docker;

    AppState {
        engine,
        store,
        sessions: Arc::new(SessionStore::new()),
        login_guard: Arc::new(login_limit::LoginGuard::default()),
        auth_mode: config.auth_mode,
        insecure_cookies: config.insecure_cookies,
    }
}

pub async fn run() {
    let config = Config::from_env().unwrap_or_else(|e| {
        eprintln!("configuración inválida: {e}");
        std::process::exit(1);
    });

    if let Err(e) = config.validate() {
        eprintln!("configuración inválida: {e}");
        std::process::exit(1);
    }
    for aviso in config.warnings() {
        eprintln!("aviso: {aviso}");
    }

    let state = build_state(&config);
    // Calcula el hash señuelo ahora: así el primer login de un usuario inexistente no tarda más.
    auth::warm_up();
    let app = build_router(&state).with_state(state);

    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .unwrap_or_else(|e| {
            eprintln!("no se pudo escuchar en {}: {e}", config.bind);
            std::process::exit(1);
        });
    eprintln!(
        "dockinng-server escuchando en {} (modo {:?})",
        config.bind, config.auth_mode
    );
    // `ConnectInfo` da la IP del cliente al limitador de login.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("el servidor terminó con un error de E/S");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    eprintln!("dockinng-server: cerrando");
}
