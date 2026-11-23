//! Validación de nombres de usuario y contraseñas nuevos (creación y reseteo).
//!
//! El nombre se limita a ASCII `[A-Za-z0-9._-]`: sin espacios, sin caracteres de control y sin
//! homógrafos Unicode («аdmin» con una «а» cirílica) que permitan suplantar a otro usuario a
//! simple vista. La unicidad sigue siendo insensible a mayúsculas (`COLLATE NOCASE`, solo ASCII,
//! que con este alfabeto es exacta).

pub const MIN_USERNAME_LEN: usize = 3;
pub const MAX_USERNAME_LEN: usize = 64;
/// En CARACTERES, no bytes: una contraseña de 8 «ñ» no es más débil que una de 8 letras ASCII.
pub const MIN_PASSWORD_CHARS: usize = 8;
pub const MAX_PASSWORD_CHARS: usize = 128;

pub fn validate_username(name: &str) -> Result<(), String> {
    let n = name.chars().count();
    if !(MIN_USERNAME_LEN..=MAX_USERNAME_LEN).contains(&n) {
        return Err(format!(
            "el nombre de usuario debe tener entre {MIN_USERNAME_LEN} y {MAX_USERNAME_LEN} caracteres"
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(
            "el nombre de usuario solo admite letras ASCII, números, «.», «_» y «-»".into(),
        );
    }
    Ok(())
}

pub fn validate_password(password: &str) -> Result<(), String> {
    let n = password.chars().count();
    if n < MIN_PASSWORD_CHARS {
        return Err(format!(
            "la contraseña debe tener al menos {MIN_PASSWORD_CHARS} caracteres"
        ));
    }
    if n > MAX_PASSWORD_CHARS {
        return Err(format!(
            "la contraseña no puede pasar de {MAX_PASSWORD_CHARS} caracteres"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_validos() {
        for ok in ["ana", "Ana.Gomez", "ops_1", "a-b", &"x".repeat(64)] {
            assert!(validate_username(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn usernames_invalidos() {
        for bad in [
            "",
            "ab",
            " ana",
            "ana ",
            "a na",
            "ana\n",
            "аdmin", // «а» cirílica
            "ñandú",
            "a@b",
            "ana/../",
            &"x".repeat(65),
        ] {
            assert!(validate_username(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn la_contrasena_se_mide_en_caracteres() {
        assert!(validate_password("1234567").is_err());
        assert!(validate_password("12345678").is_ok());
        // 8 caracteres de 2 bytes: ok (con `len()` serían 16 bytes y pasaría aunque tuviera 4).
        assert!(validate_password("ññññññññ").is_ok());
        assert!(validate_password("ññññ").is_err());
        assert!(validate_password(&"a".repeat(128)).is_ok());
        assert!(validate_password(&"a".repeat(129)).is_err());
    }
}
