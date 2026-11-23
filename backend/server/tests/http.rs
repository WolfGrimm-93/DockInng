//! Tests de integración de punta a punta: construyen el router real y le mandan pedidos HTTP
//! en memoria (sin abrir ningún socket), con un motor simulado (`engine_core::testing::MockEngine`)
//! y un almacén SQLite en un directorio temporal.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode, header};
use engine_core::testing::MockEngine;
use engine_core::{ContainerState, EngineClient, Role};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use server::config::AuthMode;
use server::session::SessionStore;
use server::state::AppState;
use store::Store;
use tower::ServiceExt;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("dockinng-test-server-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn open_store(dir: &Path) -> Arc<Store> {
    Arc::new(Store::open(dir).unwrap())
}

fn state_single(engine: Arc<dyn EngineClient>) -> AppState {
    AppState {
        engine,
        store: None,
        sessions: Arc::new(SessionStore::new()),
        login_guard: Arc::new(server::login_limit::LoginGuard::default()),
        auth_mode: AuthMode::Single,
        insecure_cookies: true,
    }
}

fn state_multi(engine: Arc<dyn EngineClient>, store: Arc<Store>) -> AppState {
    AppState {
        engine,
        store: Some(store),
        sessions: Arc::new(SessionStore::new()),
        login_guard: Arc::new(server::login_limit::LoginGuard::default()),
        auth_mode: AuthMode::Multi,
        insecure_cookies: true,
    }
}

fn mock_engine_con_un_contenedor() -> Arc<dyn EngineClient> {
    let mock = MockEngine::new();
    mock.state().containers.push(MockEngine::container(
        "c1",
        "web",
        ContainerState::Running,
        "2026-01-01T00:00:00Z",
    ));
    Arc::new(mock)
}

fn app(state: &AppState) -> Router {
    server::build_router(state).with_state(state.clone())
}

fn req(method: &str, uri: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

fn json_req(method: &str, uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn with_cookie(mut r: Request<Body>, cookie: &str) -> Request<Body> {
    r.headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    r
}

/// El valor completo de la cookie (`nombre=token`), listo para mandar en el próximo pedido.
fn cookie_from(headers: &HeaderMap) -> String {
    let raw = headers
        .get(header::SET_COOKIE)
        .expect("se esperaba Set-Cookie")
        .to_str()
        .unwrap();
    raw.split(';').next().unwrap().to_string()
}

async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn healthz_responde_ok() {
    let state = state_single(mock_engine_con_un_contenedor());
    let resp = app(&state).oneshot(req("GET", "/healthz")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn modo_single_no_requiere_login_y_me_responde_admin_local() {
    let state = state_single(mock_engine_con_un_contenedor());
    let resp = app(&state).oneshot(req("GET", "/api/auth/me")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["username"], "local");
    assert_eq!(body["role"], "admin");
}

#[tokio::test]
async fn modo_single_login_no_esta_implementado() {
    let state = state_single(mock_engine_con_un_contenedor());
    let resp = app(&state)
        .oneshot(json_req(
            "POST",
            "/api/auth/login",
            json!({"username": "x", "password": "y"}),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
}

#[tokio::test]
async fn modo_single_no_registra_rutas_de_usuarios() {
    let state = state_single(mock_engine_con_un_contenedor());
    let resp = app(&state).oneshot(req("GET", "/api/users")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn modo_multi_sin_cookie_es_401_en_me_y_en_contenedores() {
    let t = TempDir::new("sincookie");
    let state = state_multi(mock_engine_con_un_contenedor(), open_store(&t.0));
    for uri in ["/api/auth/me", "/api/containers", "/api/users"] {
        let resp = app(&state).oneshot(req("GET", uri)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
}

#[tokio::test]
async fn login_incorrecto_es_401_exista_o_no_el_usuario() {
    let t = TempDir::new("loginbad");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    store.user_create("ana", &hash, Role::Viewer).unwrap();
    let state = state_multi(mock_engine_con_un_contenedor(), store);

    for (user, pass) in [("ana", "incorrecta"), ("nadie", "lo-que-sea")] {
        let resp = app(&state)
            .oneshot(json_req(
                "POST",
                "/api/auth/login",
                json!({"username": user, "password": pass}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{user}");
    }
}

#[tokio::test]
async fn login_correcto_fija_cookie_que_sirve_para_me_y_logout_la_invalida() {
    let t = TempDir::new("loginok");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    store.user_create("ana", &hash, Role::Operator).unwrap();
    let state = state_multi(mock_engine_con_un_contenedor(), store);

    let resp = app(&state)
        .oneshot(json_req(
            "POST",
            "/api/auth/login",
            json!({"username": "ana", "password": "correcta-123"}),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let cookie = cookie_from(resp.headers());
    let body = body_json(resp).await;
    assert_eq!(body["username"], "ana");
    assert_eq!(body["role"], "operator");

    let resp = app(&state)
        .oneshot(with_cookie(req("GET", "/api/auth/me"), &cookie))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["username"], "ana");

    let resp = app(&state)
        .oneshot(with_cookie(req("POST", "/api/auth/logout"), &cookie))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    let resp = app(&state)
        .oneshot(with_cookie(req("GET", "/api/auth/me"), &cookie))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "la cookie ya no debe servir");
}

async fn login_cookie(state: &AppState, username: &str, password: &str) -> String {
    let resp = app(state)
        .oneshot(json_req(
            "POST",
            "/api/auth/login",
            json!({"username": username, "password": password}),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "login de {username} debía funcionar");
    cookie_from(resp.headers())
}

#[tokio::test]
async fn viewer_no_puede_gestionar_usuarios_pero_si_ver_contenedores() {
    let t = TempDir::new("viewer");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    store.user_create("vera", &hash, Role::Viewer).unwrap();
    let state = state_multi(mock_engine_con_un_contenedor(), store);
    let cookie = login_cookie(&state, "vera", "correcta-123").await;

    let resp = app(&state)
        .oneshot(with_cookie(req("GET", "/api/users"), &cookie))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    let resp = app(&state)
        .oneshot(with_cookie(req("GET", "/api/containers"), &cookie))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body[0]["names"][0], "web");
}

#[tokio::test]
async fn admin_crea_lista_y_borra_usuarios() {
    let t = TempDir::new("admincrud");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    store.user_create("root", &hash, Role::Admin).unwrap();
    let state = state_multi(mock_engine_con_un_contenedor(), store);
    let cookie = login_cookie(&state, "root", "correcta-123").await;

    let resp = app(&state)
        .oneshot(with_cookie(
            json_req(
                "POST",
                "/api/users",
                json!({"username": "beto", "password": "otra-clave-larga", "role": "viewer"}),
            ),
            &cookie,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let created = body_json(resp).await;
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["role"], "viewer");
    // Nunca se expone el hash de la contraseña.
    assert!(created.get("password_hash").is_none());
    assert!(created.get("password").is_none());

    let resp = app(&state)
        .oneshot(with_cookie(req("GET", "/api/users"), &cookie))
        .await
        .unwrap();
    let list = body_json(resp).await;
    assert_eq!(list.as_array().unwrap().len(), 2);

    let resp = app(&state)
        .oneshot(with_cookie(req("DELETE", &format!("/api/users/{id}")), &cookie))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    let resp = app(&state)
        .oneshot(with_cookie(req("GET", "/api/users"), &cookie))
        .await
        .unwrap();
    assert_eq!(body_json(resp).await.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn no_se_puede_dejar_el_sistema_sin_ningun_administrador() {
    let t = TempDir::new("lastadmin");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    let admin = store.user_create("root", &hash, Role::Admin).unwrap();
    let state = state_multi(mock_engine_con_un_contenedor(), store);
    let cookie = login_cookie(&state, "root", "correcta-123").await;

    // Degradar al único admin: rechazado.
    let resp = app(&state)
        .oneshot(with_cookie(
            json_req(
                "PATCH",
                &format!("/api/users/{}/role", admin.id),
                json!({"role": "viewer"}),
            ),
            &cookie,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);

    // Borrar al único admin: también rechazado (además de ser el propio usuario logueado).
    let resp = app(&state)
        .oneshot(with_cookie(
            req("DELETE", &format!("/api/users/{}", admin.id)),
            &cookie,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn admin_no_puede_borrar_su_propio_usuario_aunque_haya_otro_admin() {
    let t = TempDir::new("noselfdelete");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    let root = store.user_create("root", &hash, Role::Admin).unwrap();
    store.user_create("otro", &hash, Role::Admin).unwrap();
    let state = state_multi(mock_engine_con_un_contenedor(), store);
    let cookie = login_cookie(&state, "root", "correcta-123").await;

    let resp = app(&state)
        .oneshot(with_cookie(req("DELETE", &format!("/api/users/{}", root.id)), &cookie))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn cambiar_el_rol_cierra_las_sesiones_viejas_del_usuario() {
    let t = TempDir::new("rolecloses");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    store.user_create("root", &hash, Role::Admin).unwrap();
    let target = store.user_create("beto", &hash, Role::Operator).unwrap();
    let state = state_multi(mock_engine_con_un_contenedor(), store);
    let admin_cookie = login_cookie(&state, "root", "correcta-123").await;
    let beto_cookie = login_cookie(&state, "beto", "correcta-123").await;

    let resp = app(&state)
        .oneshot(with_cookie(
            json_req(
                "PATCH",
                &format!("/api/users/{}/role", target.id),
                json!({"role": "viewer"}),
            ),
            &admin_cookie,
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // La cookie vieja de Beto ya no sirve: su sesión se cerró al cambiarle el rol.
    let resp = app(&state)
        .oneshot(with_cookie(req("GET", "/api/auth/me"), &beto_cookie))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------------------------
// Fuerza bruta, longitudes y caducidad de sesiones
// ---------------------------------------------------------------------------------------------

async fn login_status(state: &AppState, user: &str, pass: &str) -> axum::response::Response {
    app(state)
        .oneshot(json_req(
            "POST",
            "/api/auth/login",
            json!({"username": user, "password": pass}),
        ))
        .await
        .unwrap()
}

fn state_con_usuario(tag: &str) -> (TempDir, AppState) {
    let t = TempDir::new(tag);
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    store.user_create("ana", &hash, Role::Operator).unwrap();
    let state = state_multi(mock_engine_con_un_contenedor(), store);
    (t, state)
}

#[tokio::test]
async fn tras_cinco_fallos_el_login_se_bloquea_con_429_aunque_la_clave_sea_correcta() {
    let (_t, state) = state_con_usuario("bruta");
    for _ in 0..5 {
        let r = login_status(&state, "ana", "mala").await;
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    }
    let r = login_status(&state, "ana", "correcta-123").await;
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry: u64 = r.headers()["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((1..=900).contains(&retry), "{retry}");
    assert!(r.headers().get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn un_usuario_inexistente_se_bloquea_igual_y_no_delata_que_no_existe() {
    let (_t, state) = state_con_usuario("bruta-nadie");
    for _ in 0..5 {
        login_status(&state, "nadie", "x").await;
    }
    let r = login_status(&state, "nadie", "x").await;
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn un_login_correcto_antes_del_umbral_reinicia_el_contador() {
    let (_t, state) = state_con_usuario("bruta-reset");
    for _ in 0..4 {
        login_status(&state, "ana", "mala").await;
    }
    assert_eq!(
        login_status(&state, "ana", "correcta-123").await.status(),
        StatusCode::OK
    );
    for _ in 0..4 {
        assert_eq!(
            login_status(&state, "ana", "mala").await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn usuario_o_contrasena_gigantes_se_rechazan_sin_verificar() {
    let (_t, state) = state_con_usuario("largos");
    let r = login_status(&state, &"a".repeat(300), "x").await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = login_status(&state, "ana", &"p".repeat(5000)).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    // No cuentan como fallos de autenticación: no bloquean a nadie.
    assert_eq!(
        login_status(&state, "ana", "correcta-123").await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn la_cookie_caduca_en_el_navegador_junto_con_la_sesion() {
    let (_t, state) = state_con_usuario("maxage");
    let r = login_status(&state, "ana", "correcta-123").await;
    let set = r.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
    assert!(set.contains("Max-Age=43200"), "{set}");
}

#[tokio::test]
async fn una_sesion_inactiva_deja_de_valer() {
    let t = TempDir::new("idle");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    store.user_create("ana", &hash, Role::Operator).unwrap();
    let mut state = state_multi(mock_engine_con_un_contenedor(), store);
    state.sessions = Arc::new(SessionStore::with_policy(server::session::SessionPolicy {
        idle_ttl: std::time::Duration::ZERO,
        ..Default::default()
    }));
    let r = login_status(&state, "ana", "correcta-123").await;
    let cookie = cookie_from(r.headers());
    let r = app(&state)
        .oneshot(with_cookie(req("GET", "/api/auth/me"), &cookie))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn el_tope_de_sesiones_por_usuario_expulsa_la_mas_vieja() {
    let t = TempDir::new("tope");
    let store = open_store(&t.0);
    let hash = store::password::hash_password("correcta-123").unwrap();
    store.user_create("ana", &hash, Role::Operator).unwrap();
    let mut state = state_multi(mock_engine_con_un_contenedor(), store);
    state.sessions = Arc::new(SessionStore::with_policy(server::session::SessionPolicy {
        max_per_user: 1,
        ..Default::default()
    }));
    let c1 = cookie_from(login_status(&state, "ana", "correcta-123").await.headers());
    let c2 = cookie_from(login_status(&state, "ana", "correcta-123").await.headers());
    let me = |c: String| {
        let st = state.clone();
        async move {
            app(&st)
                .oneshot(with_cookie(req("GET", "/api/auth/me"), &c))
                .await
                .unwrap()
                .status()
        }
    };
    assert_eq!(me(c1).await, StatusCode::UNAUTHORIZED);
    assert_eq!(me(c2).await, StatusCode::OK);
}

#[tokio::test]
async fn el_bloqueo_por_ip_usa_la_direccion_de_la_conexion_y_no_afecta_a_otras_ips() {
    use axum::extract::ConnectInfo;
    use server::login_limit::{LimitPolicy, LoginGuard};
    let (_t, mut state) = state_con_usuario("porip");
    state.login_guard = Arc::new(LoginGuard::new(LimitPolicy {
        max_ip_failures: 3,
        ..Default::default()
    }));
    let desde = |ip: &str, user: &str, pass: &str| {
        let mut r = json_req(
            "POST",
            "/api/auth/login",
            json!({"username": user, "password": pass}),
        );
        let addr: std::net::SocketAddr = format!("{ip}:4000").parse().unwrap();
        r.extensions_mut().insert(ConnectInfo(addr));
        r
    };
    // Tres fallos desde la misma IP con usuarios distintos (ninguno llega al umbral del usuario).
    for u in ["a", "b", "c"] {
        let r = app(&state).oneshot(desde("203.0.113.7", u, "x")).await.unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    }
    let r = app(&state)
        .oneshot(desde("203.0.113.7", "ana", "correcta-123"))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
    // Otra IP entra con normalidad.
    let r = app(&state)
        .oneshot(desde("203.0.113.8", "ana", "correcta-123"))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
}
