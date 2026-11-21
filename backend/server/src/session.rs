//! Sesiones del servidor (modo multiusuario). Viven en memoria del proceso: se pierden al
//! reiniciar (cada usuario tiene que volver a entrar). Persistirlas entre reinicios queda
//! pendiente — ver `PENDIENTES.md`. Caducan por antigüedad y por inactividad y hay un tope de
//! sesiones por usuario (`SessionPolicy`).

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use engine_core::Role;
use uuid::Uuid;

/// Token de sesión: un secreto aleatorio, no un id de recurso — por eso usa UUID v4 (122 bits
/// de un generador criptográfico) en vez de UUID v7 (que codifica la hora de creación, algo
/// que no debería filtrarse en una credencial). Excepción documentada a la regla "todo id
/// nuevo es v7", en el mismo espíritu que `LOCAL_CONNECTION_ID` en `store`: esto no identifica
/// un recurso, es un secreto que viaja como cookie.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionToken(String);

impl SessionToken {
    fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Solo acepta algo con forma de UUID: cualquier otra cosa no puede ser un token propio.
    pub fn parse(s: &str) -> Option<Self> {
        Uuid::parse_str(s).ok().map(|u| Self(u.to_string()))
    }
}

/// Límites de vida de las sesiones. Sin ellos un token robado valdría hasta reiniciar el
/// proceso y cada login añadiría una entrada sin tope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionPolicy {
    /// Vida máxima desde el login, se use o no.
    pub absolute_ttl: Duration,
    /// Tiempo máximo sin usar la sesión.
    pub idle_ttl: Duration,
    /// Sesiones vivas por usuario: al pasarse se descarta la menos usada.
    pub max_per_user: usize,
}

impl Default for SessionPolicy {
    fn default() -> Self {
        Self {
            absolute_ttl: Duration::from_secs(12 * 3600),
            idle_ttl: Duration::from_secs(30 * 60),
            max_per_user: 5,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionData {
    pub user_id: String,
    pub username: String,
    pub role: Role,
    created_at: Instant,
    last_seen: Instant,
}

impl SessionData {
    fn expired(&self, policy: &SessionPolicy, now: Instant) -> bool {
        now.saturating_duration_since(self.created_at) >= policy.absolute_ttl
            || now.saturating_duration_since(self.last_seen) >= policy.idle_ttl
    }
}

#[derive(Default)]
pub struct SessionStore {
    sessions: RwLock<HashMap<String, SessionData>>,
    policy: SessionPolicy,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_policy(policy: SessionPolicy) -> Self {
        Self {
            sessions: RwLock::default(),
            policy,
        }
    }

    pub fn policy(&self) -> SessionPolicy {
        self.policy
    }

    pub fn create(&self, user_id: String, username: String, role: Role) -> SessionToken {
        self.create_at(user_id, username, role, Instant::now())
    }

    pub(crate) fn create_at(
        &self,
        user_id: String,
        username: String,
        role: Role,
        now: Instant,
    ) -> SessionToken {
        let token = SessionToken::generate();
        let mut map = self.sessions.write().unwrap_or_else(|e| e.into_inner());
        // Purga las vencidas (acota la memoria aunque nadie vuelva a usarlas).
        map.retain(|_, s| !s.expired(&self.policy, now));
        // Tope por usuario: se descarta la menos usada hasta dejar sitio para la nueva.
        loop {
            let mine: Vec<(&String, Instant)> = map
                .iter()
                .filter(|(_, s)| s.user_id == user_id)
                .map(|(k, s)| (k, s.last_seen))
                .collect();
            if mine.len() < self.policy.max_per_user.max(1) {
                break;
            }
            let Some(oldest) = mine.iter().min_by_key(|(_, seen)| *seen).map(|(k, _)| (*k).clone())
            else {
                break;
            };
            map.remove(&oldest);
        }
        map.insert(
            token.0.clone(),
            SessionData {
                user_id,
                username,
                role,
                created_at: now,
                last_seen: now,
            },
        );
        token
    }

    /// Devuelve la sesión si sigue viva y renueva su inactividad. Una vencida se borra.
    pub fn get(&self, token: &SessionToken) -> Option<SessionData> {
        self.get_at(token, Instant::now())
    }

    pub(crate) fn get_at(&self, token: &SessionToken, now: Instant) -> Option<SessionData> {
        let mut map = self.sessions.write().unwrap_or_else(|e| e.into_inner());
        let vigente = match map.get_mut(&token.0) {
            Some(s) if !s.expired(&self.policy, now) => {
                s.last_seen = now;
                Some(s.clone())
            }
            Some(_) => None,
            None => return None,
        };
        if vigente.is_none() {
            map.remove(&token.0);
        }
        vigente
    }

    pub fn remove(&self, token: &SessionToken) {
        self.sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&token.0);
    }

    /// Cierra todas las sesiones de un usuario: tras borrarlo o cambiarle el rol, ninguna
    /// sesión vieja debe seguir viva con los permisos anteriores.
    pub fn remove_all_for_user(&self, user_id: &str) {
        self.sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, s| s.user_id != user_id);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.sessions.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crea_recupera_y_borra_sesion() {
        let s = SessionStore::new();
        let token = s.create("u1".into(), "ana".into(), Role::Admin);
        let data = s.get(&token).unwrap();
        assert_eq!(data.user_id, "u1");
        assert_eq!(data.role, Role::Admin);
        s.remove(&token);
        assert!(s.get(&token).is_none());
    }

    #[test]
    fn tokens_generados_son_distintos() {
        let s = SessionStore::new();
        let a = s.create("u1".into(), "ana".into(), Role::Viewer);
        let b = s.create("u1".into(), "ana".into(), Role::Viewer);
        assert_ne!(a, b);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn token_con_forma_invalida_no_parsea() {
        assert!(SessionToken::parse("no-es-un-uuid").is_none());
        assert!(SessionToken::parse("").is_none());
    }

    #[test]
    fn cerrar_sesiones_de_un_usuario_no_toca_las_de_otro() {
        let s = SessionStore::new();
        let t1 = s.create("u1".into(), "ana".into(), Role::Admin);
        let t2 = s.create("u2".into(), "beto".into(), Role::Viewer);
        s.remove_all_for_user("u1");
        assert!(s.get(&t1).is_none());
        assert!(s.get(&t2).is_some());
    }

    fn policy(abs_s: u64, idle_s: u64, max: usize) -> SessionPolicy {
        SessionPolicy {
            absolute_ttl: Duration::from_secs(abs_s),
            idle_ttl: Duration::from_secs(idle_s),
            max_per_user: max,
        }
    }

    #[test]
    fn caduca_por_inactividad_pero_usarla_la_renueva() {
        let s = SessionStore::with_policy(policy(1000, 60, 5));
        let t0 = Instant::now();
        let tok = s.create_at("u1".into(), "ana".into(), Role::Admin, t0);
        assert!(s.get_at(&tok, t0 + Duration::from_secs(50)).is_some());
        // 50 s después del último uso (t0+50): sigue viva aunque hayan pasado 100 s desde el login.
        assert!(s.get_at(&tok, t0 + Duration::from_secs(100)).is_some());
        // 61 s sin usarla: vencida y borrada.
        assert!(s.get_at(&tok, t0 + Duration::from_secs(161)).is_none());
        assert!(s.is_empty());
    }

    #[test]
    fn caduca_por_antiguedad_aunque_se_use_sin_parar() {
        let s = SessionStore::with_policy(policy(100, 60, 5));
        let t0 = Instant::now();
        let tok = s.create_at("u1".into(), "ana".into(), Role::Admin, t0);
        for i in 1..=9 {
            assert!(s.get_at(&tok, t0 + Duration::from_secs(i * 10)).is_some());
        }
        assert!(s.get_at(&tok, t0 + Duration::from_secs(100)).is_none());
    }

    #[test]
    fn el_tope_por_usuario_descarta_la_menos_usada_y_no_toca_a_otros() {
        let s = SessionStore::with_policy(policy(1000, 1000, 2));
        let t0 = Instant::now();
        let a = s.create_at("u1".into(), "ana".into(), Role::Viewer, t0);
        let b = s.create_at("u1".into(), "ana".into(), Role::Viewer, t0 + Duration::from_secs(1));
        let otro = s.create_at("u2".into(), "beto".into(), Role::Viewer, t0);
        // `a` se usa: la menos usada pasa a ser `b`.
        assert!(s.get_at(&a, t0 + Duration::from_secs(2)).is_some());
        let c = s.create_at("u1".into(), "ana".into(), Role::Viewer, t0 + Duration::from_secs(3));
        assert!(s.get_at(&b, t0 + Duration::from_secs(4)).is_none());
        assert!(s.get_at(&a, t0 + Duration::from_secs(4)).is_some());
        assert!(s.get_at(&c, t0 + Duration::from_secs(4)).is_some());
        assert!(s.get_at(&otro, t0 + Duration::from_secs(4)).is_some());
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn crear_purga_las_vencidas_y_acota_la_memoria() {
        let s = SessionStore::with_policy(policy(1000, 10, 1000));
        let t0 = Instant::now();
        for i in 0..50 {
            s.create_at(format!("u{i}"), "x".into(), Role::Viewer, t0);
        }
        assert_eq!(s.len(), 50);
        s.create_at("nuevo".into(), "y".into(), Role::Viewer, t0 + Duration::from_secs(11));
        assert_eq!(s.len(), 1);
    }
}
