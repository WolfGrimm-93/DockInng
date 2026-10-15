//! Hash y verificación de contraseñas (usuarios del servidor web) con Argon2.
//!
//! El string que guarda `hash_password` es autodescriptivo (algoritmo, sal y parámetros
//! incluidos, formato estándar `$argon2id$...`): no hace falta guardar la sal por separado.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng};
use argon2::Argon2;

use crate::error::StoreError;

/// Genera el hash de `plain`. Falla solo si Argon2 rechaza los parámetros (no debería pasar
/// con los valores por defecto).
pub fn hash_password(plain: &str) -> Result<String, StoreError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| StoreError::Hash(e.to_string()))
}

/// Compara `plain` contra `hash` (el string guardado por `hash_password`). `false` tanto si
/// no coincide como si `hash` está corrupto: nunca hay que distinguir ambos casos al usuario.
pub fn verify_password(hash: &str, plain: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(plain.as_bytes(), &parsed)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashea_y_verifica_la_contrasena_correcta() {
        let hash = hash_password("correcta-123").unwrap();
        assert!(verify_password(&hash, "correcta-123"));
    }

    #[test]
    fn rechaza_la_contrasena_incorrecta() {
        let hash = hash_password("correcta-123").unwrap();
        assert!(!verify_password(&hash, "otra-cosa"));
    }

    #[test]
    fn dos_hashes_de_la_misma_contrasena_son_distintos() {
        // Cada llamada usa una sal nueva: ni el string del hash coincide.
        let a = hash_password("misma").unwrap();
        let b = hash_password("misma").unwrap();
        assert_ne!(a, b);
        assert!(verify_password(&a, "misma"));
        assert!(verify_password(&b, "misma"));
    }

    #[test]
    fn hash_corrupto_no_verifica_y_no_entra_en_panico() {
        assert!(!verify_password("no-es-un-hash-argon2", "cualquiera"));
        assert!(!verify_password("", "cualquiera"));
    }
}
