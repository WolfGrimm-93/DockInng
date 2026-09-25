//! Validación de identificadores antes de interpolarlos en rutas del motor.
//! bollard hace `format!("/containers/{id}/json")` sin escapar: un id con `/` o `?`
//! alteraría la ruta de la petición.

use crate::EngineError;

const MAX_LEN: usize = 255;

fn check(value: &str, what: &str, extra: &[char]) -> Result<(), EngineError> {
    let mut chars = value.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_ok = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') || extra.contains(&c));
    if value.len() > MAX_LEN
        || !first_ok
        || !rest_ok
        || value.split('/').any(|seg| seg == ".." || seg == ".")
    {
        return Err(EngineError::InvalidInput(format!(
            "{what} con caracteres no permitidos"
        )));
    }
    Ok(())
}

/// Id o nombre de contenedor / red.
pub fn container_id(value: &str) -> Result<(), EngineError> {
    check(value, "identificador", &[])
}

/// Nombre de volumen.
pub fn volume_name(value: &str) -> Result<(), EngineError> {
    check(value, "nombre de volumen", &[])
}

/// Referencia de imagen: permite `/ : @` (repo/nombre:tag@sha256:...).
pub fn image_reference(value: &str) -> Result<(), EngineError> {
    check(value, "referencia de imagen", &['/', ':', '@'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rechaza_ids_que_alteran_la_ruta() {
        for bad in ["", "a/b", "a?x=1", "a b", "a\nb", "../x", "-x", "a#b"] {
            assert!(container_id(bad).is_err(), "{bad:?}");
        }
        assert!(container_id("dockinng-test_1.a").is_ok());
        assert!(container_id(&"a".repeat(256)).is_err());
    }

    #[test]
    fn referencias_de_imagen() {
        assert!(image_reference("ghcr.io/x/y:1.2@sha256:abcd").is_ok());
        assert!(image_reference("sha256:abcd").is_ok());
        assert!(image_reference("a b").is_err());
        assert!(image_reference("a/../b").is_err());
        assert!(image_reference("a/./b").is_err());
        // `..` dentro de un nombre no es un segmento de ruta.
        assert!(image_reference("repo/a..b:1.0..rc").is_ok());
        assert!(container_id("a..b").is_ok());
        assert!(container_id("..").is_err());
        assert!(image_reference("x/..").is_err());
        assert!(volume_name("a/b").is_err());
    }
}
