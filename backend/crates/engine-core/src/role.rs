//! Roles de acceso para el servidor web (modo multiusuario).
//!
//! No aplica a la app de escritorio ni a la CLI: ambas corren con la confianza del usuario
//! del sistema operativo local, igual que hoy. El servidor web es el único adaptador que
//! expone el motor por red y necesita decidir quién puede ver y quién puede actuar.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Gestiona usuarios y roles, además de todo lo que puede `Operator`.
    Admin,
    /// Puede ver el motor y ejecutar acciones sobre él (sujetas igual a `ConfirmationPolicy`).
    Operator,
    /// Solo lectura: nunca puede ejecutar una acción que modifique el motor.
    Viewer,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Operator => "operator",
            Role::Viewer => "viewer",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "admin" => Some(Role::Admin),
            "operator" => Some(Role::Operator),
            "viewer" => Some(Role::Viewer),
            _ => None,
        }
    }

    /// Crear, borrar o cambiar el rol de un usuario.
    pub fn can_manage_users(&self) -> bool {
        matches!(self, Role::Admin)
    }

    /// Ejecutar una acción que modifique el motor (start/stop/remove/...). La decisión fina
    /// (confirmación, texto exacto, prohibición) sigue siendo de `ConfirmationPolicy`; este
    /// chequeo es previo y más grueso: separa quién puede llegar a pedir la acción.
    pub fn can_act(&self) -> bool {
        matches!(self, Role::Admin | Role::Operator)
    }

    /// Ver el estado del motor (listar, inspeccionar, logs, stats). Todo usuario autenticado
    /// puede, incluido `Viewer`.
    pub fn can_view(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_puede_todo() {
        assert!(Role::Admin.can_manage_users());
        assert!(Role::Admin.can_act());
        assert!(Role::Admin.can_view());
    }

    #[test]
    fn operator_actua_pero_no_gestiona_usuarios() {
        assert!(!Role::Operator.can_manage_users());
        assert!(Role::Operator.can_act());
        assert!(Role::Operator.can_view());
    }

    #[test]
    fn viewer_solo_lectura() {
        assert!(!Role::Viewer.can_manage_users());
        assert!(!Role::Viewer.can_act());
        assert!(Role::Viewer.can_view());
    }

    #[test]
    fn parse_y_as_str_son_inversos() {
        for r in [Role::Admin, Role::Operator, Role::Viewer] {
            assert_eq!(Role::parse(r.as_str()), Some(r));
        }
        assert_eq!(Role::parse("superadmin"), None);
        assert_eq!(Role::parse(""), None);
        // Sensible a mayúsculas a propósito: el valor viene de la base, no de entrada humana.
        assert_eq!(Role::parse("Admin"), None);
    }

    #[test]
    fn serializa_en_snake_case() {
        assert_eq!(serde_json::to_string(&Role::Admin).unwrap(), "\"admin\"");
        assert_eq!(
            serde_json::to_string(&Role::Operator).unwrap(),
            "\"operator\""
        );
    }
}
