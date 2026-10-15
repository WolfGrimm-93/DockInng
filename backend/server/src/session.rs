//! Sesiones del servidor (modo multiusuario). Viven en memoria del proceso: se pierden al
//! reiniciar (cada usuario tiene que volver a entrar). Persistirlas entre reinicios queda
//! pendiente — ver `PENDIENTES.md`.

use std::collections::HashMap;
use std::sync::RwLock;

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

#[derive(Debug, Clone)]
pub struct SessionData {
    pub user_id: String,
    pub username: String,
    pub role: Role,
}

#[derive(Default)]
pub struct SessionStore {
    sessions: RwLock<HashMap<String, SessionData>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&self, user_id: String, username: String, role: Role) -> SessionToken {
        let token = SessionToken::generate();
        self.sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                token.0.clone(),
                SessionData {
                    user_id,
                    username,
                    role,
                },
            );
        token
    }

    pub fn get(&self, token: &SessionToken) -> Option<SessionData> {
        self.sessions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&token.0)
            .cloned()
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
}
