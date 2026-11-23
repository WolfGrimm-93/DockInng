//! Freno a la fuerza bruta del login y tope de contraseñas verificándose a la vez.
//!
//! - Cuenta fallos por IP y por nombre de usuario (existente o no: nunca delata si el usuario
//!   existe). Al pasar el umbral bloquea con espera creciente (`backoff`), sin tocar Argon2.
//! - Limita cuántos hashes Argon2 (≈19 MiB cada uno) corren en paralelo; si no hay sitio
//!   rechaza en vez de encolar.
//!
//! Límites conocidos: el bloqueo por usuario permite que un atacante moleste a un usuario
//! legítimo (bloqueo temporal, máx. `max_backoff`); es el costo habitual de frenar la fuerza
//! bruta. Tras un proxy inverso todos los clientes comparten la IP del proxy: el umbral por IP
//! es holgado a propósito y el control fino es el del usuario. No se confía en `X-Forwarded-For`
//! (lo puede falsificar cualquiera).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Longitudes máximas aceptadas por el login (bytes). Acotan el trabajo por pedido.
pub const MAX_USERNAME_BYTES: usize = 256;
pub const MAX_PASSWORD_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy)]
pub struct LimitPolicy {
    /// Fallos dentro de esta ventana cuentan juntos.
    pub window: Duration,
    pub max_user_failures: u32,
    pub max_ip_failures: u32,
    /// Espera tras el primer fallo que pasa el umbral; se duplica por cada fallo extra.
    pub base_backoff: Duration,
    pub max_backoff: Duration,
    /// Entradas máximas del mapa (acota la memoria frente a nombres de usuario aleatorios).
    pub max_entries: usize,
    /// Hashes Argon2 simultáneos.
    pub max_concurrent_hashes: usize,
}

impl Default for LimitPolicy {
    fn default() -> Self {
        Self {
            window: Duration::from_secs(15 * 60),
            max_user_failures: 5,
            max_ip_failures: 30,
            base_backoff: Duration::from_secs(30),
            max_backoff: Duration::from_secs(15 * 60),
            max_entries: 10_000,
            max_concurrent_hashes: 4,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Entry {
    failures: u32,
    last_failure: Instant,
    blocked_until: Option<Instant>,
}

pub struct LoginGuard {
    policy: LimitPolicy,
    entries: Mutex<HashMap<String, Entry>>,
    hashing: Arc<Semaphore>,
}

impl Default for LoginGuard {
    fn default() -> Self {
        Self::new(LimitPolicy::default())
    }
}

fn ip_key(ip: Option<IpAddr>) -> String {
    match ip {
        Some(ip) => format!("ip:{ip}"),
        None => "ip:desconocida".into(),
    }
}

fn user_key(username: &str) -> String {
    format!("u:{}", username.trim().to_lowercase())
}

impl LoginGuard {
    pub fn new(policy: LimitPolicy) -> Self {
        Self {
            policy,
            entries: Mutex::new(HashMap::new()),
            hashing: Arc::new(Semaphore::new(policy.max_concurrent_hashes.max(1))),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn threshold(&self, key: &str) -> u32 {
        if key.starts_with("ip:") {
            self.policy.max_ip_failures
        } else {
            self.policy.max_user_failures
        }
    }

    /// `Err(segundos)` si la IP o el usuario están bloqueados ahora mismo.
    pub fn check(&self, ip: Option<IpAddr>, username: &str, now: Instant) -> Result<(), u64> {
        let map = self.lock();
        let wait = [ip_key(ip), user_key(username)]
            .iter()
            .filter_map(|k| map.get(k))
            .filter_map(|e| e.blocked_until)
            .filter(|b| *b > now)
            .map(|b| b.saturating_duration_since(now))
            .max();
        match wait {
            // Redondea hacia arriba: `Retry-After: 0` invitaría a reintentar de inmediato.
            Some(d) => Err(d.as_secs() + u64::from(d.subsec_nanos() > 0)),
            None => Ok(()),
        }
    }

    /// Anota un fallo de autenticación contra la IP y el usuario.
    pub fn record_failure(&self, ip: Option<IpAddr>, username: &str, now: Instant) {
        let mut map = self.lock();
        for key in [ip_key(ip), user_key(username)] {
            self.bump(&mut map, key, now);
        }
    }

    fn bump(&self, map: &mut HashMap<String, Entry>, key: String, now: Instant) {
        if !map.contains_key(&key) && map.len() >= self.policy.max_entries {
            self.make_room(map, now);
        }
        let threshold = self.threshold(&key);
        let policy = self.policy;
        let e = map.entry(key).or_insert(Entry {
            failures: 0,
            last_failure: now,
            blocked_until: None,
        });
        let bloqueado = e.blocked_until.is_some_and(|b| b > now);
        if !bloqueado && now.saturating_duration_since(e.last_failure) >= policy.window {
            e.failures = 0;
            e.blocked_until = None;
        }
        e.failures = e.failures.saturating_add(1);
        e.last_failure = now;
        if e.failures >= threshold {
            let extra = (e.failures - threshold).min(20);
            let backoff = policy
                .base_backoff
                .checked_mul(1u32 << extra)
                .unwrap_or(policy.max_backoff)
                .min(policy.max_backoff);
            e.blocked_until = Some(now + backoff);
        }
    }

    /// Libera sitio: primero las entradas caducadas; si no basta, la de fallo más antiguo.
    fn make_room(&self, map: &mut HashMap<String, Entry>, now: Instant) {
        let window = self.policy.window;
        map.retain(|_, e| {
            e.blocked_until.is_some_and(|b| b > now)
                || now.saturating_duration_since(e.last_failure) < window
        });
        if map.len() >= self.policy.max_entries
            && let Some(oldest) = map
                .iter()
                .min_by_key(|(_, e)| e.last_failure)
                .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
    }

    /// Un login correcto limpia el contador del usuario (el de la IP no: una IP que acierta
    /// una cuenta propia no queda absuelta de haber probado otras).
    pub fn record_success(&self, username: &str) {
        self.lock().remove(&user_key(username));
    }

    /// Reserva un hueco para verificar una contraseña; `None` si ya hay el máximo en curso.
    pub fn try_hash_slot(&self) -> Option<OwnedSemaphorePermit> {
        self.hashing.clone().try_acquire_owned().ok()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> Option<IpAddr> {
        Some(IpAddr::from([10, 0, 0, n]))
    }

    fn guard() -> LoginGuard {
        LoginGuard::new(LimitPolicy {
            window: Duration::from_secs(600),
            max_user_failures: 3,
            max_ip_failures: 10,
            base_backoff: Duration::from_secs(10),
            max_backoff: Duration::from_secs(80),
            max_entries: 4,
            max_concurrent_hashes: 2,
        })
    }

    #[test]
    fn bloquea_al_pasar_el_umbral_y_la_espera_crece() {
        let g = guard();
        let t0 = Instant::now();
        for _ in 0..2 {
            g.record_failure(ip(1), "ana", t0);
        }
        assert!(g.check(ip(1), "ana", t0).is_ok());
        g.record_failure(ip(1), "ana", t0);
        assert_eq!(g.check(ip(1), "ana", t0), Err(10));
        // Pasada la espera vuelve a poder intentar; un fallo más duplica la espera.
        let t1 = t0 + Duration::from_secs(11);
        assert!(g.check(ip(1), "ana", t1).is_ok());
        g.record_failure(ip(1), "ana", t1);
        assert_eq!(g.check(ip(1), "ana", t1), Err(20));
    }

    #[test]
    fn la_espera_tiene_techo() {
        let g = guard();
        let mut t = Instant::now();
        for _ in 0..12 {
            g.record_failure(ip(1), "ana", t);
            t += Duration::from_secs(1000 / 100);
        }
        let Err(s) = g.check(ip(1), "ana", t) else {
            panic!("debería estar bloqueado")
        };
        assert!(s <= 80, "{s}");
    }

    #[test]
    fn el_usuario_se_bloquea_desde_cualquier_ip_y_sin_importar_mayusculas() {
        let g = guard();
        let t0 = Instant::now();
        g.record_failure(ip(1), "Ana", t0);
        g.record_failure(ip(2), "ana", t0);
        g.record_failure(ip(3), " ANA ", t0);
        assert!(g.check(ip(4), "ana", t0).is_err());
        // Otro usuario desde una IP limpia no se ve afectado.
        assert!(g.check(ip(4), "beto", t0).is_ok());
    }

    #[test]
    fn existir_o_no_el_usuario_no_cambia_el_comportamiento() {
        // El limitador solo conoce el texto del nombre: nunca consulta si existe.
        let g = guard();
        let t0 = Instant::now();
        for _ in 0..3 {
            g.record_failure(ip(1), "no-existe", t0);
        }
        assert!(g.check(ip(9), "no-existe", t0).is_err());
    }

    #[test]
    fn la_ip_se_bloquea_aunque_cambie_de_usuario() {
        let g = guard();
        let t0 = Instant::now();
        for i in 0..10 {
            g.record_failure(ip(1), &format!("u{i}"), t0);
        }
        assert!(g.check(ip(1), "otro", t0).is_err());
        assert!(g.check(ip(2), "otro", t0).is_ok());
    }

    #[test]
    fn un_login_correcto_limpia_al_usuario_pero_no_a_la_ip() {
        let g = guard();
        let t0 = Instant::now();
        for _ in 0..3 {
            g.record_failure(ip(1), "ana", t0);
        }
        g.record_success("ana");
        assert!(g.check(ip(2), "ana", t0).is_ok());
        assert!(g.lock().contains_key("ip:10.0.0.1"));
    }

    #[test]
    fn los_fallos_viejos_no_cuentan_pasada_la_ventana() {
        let g = guard();
        let t0 = Instant::now();
        g.record_failure(ip(1), "ana", t0);
        g.record_failure(ip(1), "ana", t0);
        let t1 = t0 + Duration::from_secs(601);
        g.record_failure(ip(1), "ana", t1);
        assert!(g.check(ip(1), "ana", t1).is_ok());
    }

    #[test]
    fn el_mapa_no_crece_sin_limite() {
        let g = guard();
        let t0 = Instant::now();
        for i in 0..200 {
            g.record_failure(ip(1), &format!("usuario-{i}"), t0 + Duration::from_millis(i));
            assert!(g.len() <= 4, "{}", g.len());
        }
    }

    #[test]
    fn los_hashes_simultaneos_tienen_tope() {
        let g = guard();
        let a = g.try_hash_slot();
        let b = g.try_hash_slot();
        assert!(a.is_some() && b.is_some());
        assert!(g.try_hash_slot().is_none());
        drop(a);
        assert!(g.try_hash_slot().is_some());
    }
}
