//! Tickets de un solo uso que ligan un plan (previa) con su ejecución.
//! Sin tokio ni Tauri: testeable con un reloj falso.
//!
//! RIESGO RESIDUAL ACEPTADO (ALTO): el ticket es un CONTRATO, no una frontera de seguridad.
//! Un webview comprometido (XSS, contenido remoto) puede llamar `plan_action` y luego
//! `execute_action(ticket, "ELIMINAR")` sin ningún gesto humano: el texto de confirmación lo
//! aporta el mismo proceso que lo pide. Lo que el ticket garantiza es que ningún camino
//! *legítimo* de la app se salte la política (preview del servidor, escritura exigida, un solo
//! uso, objetivos resueltos por el backend). La barrera real contra ese ataque es la CSP
//! estricta y la ausencia de contenido remoto en la ventana; no hay diálogo nativo de
//! confirmación en esta ronda.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::policy::Decision;

/// Tiempo de vida de un ticket.
pub const TICKET_TTL: Duration = Duration::from_secs(120);
/// Máximo de tickets pendientes (se expulsa el más viejo).
pub const MAX_PENDING: usize = 32;
/// Intentos de confirmación escrita fallidos antes de invalidar el ticket.
pub const MAX_TYPED_ATTEMPTS: u8 = 5;

/// Reloj monotónico inyectable (tiempo transcurrido desde un origen arbitrario).
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
}

pub struct SystemClock(Instant);

impl SystemClock {
    pub fn new() -> Self {
        Self(Instant::now())
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

/// Demasiados tickets vigentes: el plan nuevo se rechaza (no se expulsa uno legítimo).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrokerFull;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedeemError {
    /// No existe, ya se usó o se invalidó.
    Invalid,
    Expired,
    /// La confirmación escrita no coincide (el ticket sigue vivo mientras queden intentos).
    TypedMismatch,
}

struct Entry<P> {
    payload: P,
    decision: Decision,
    expires: Duration,
    attempts: u8,
}

struct Inner<P> {
    map: HashMap<String, Entry<P>>,
}

pub struct Broker<P> {
    inner: Mutex<Inner<P>>,
    clock: Arc<dyn Clock>,
}

impl<P> Broker<P> {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                map: HashMap::new(),
            }),
            clock,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<P>> {
        // Un panic previo no debe dejar la app sin tickets.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Emite un ticket (UUID v7). Purga los expirados; si aun así hay `MAX_PENDING`
    /// vigentes rechaza el nuevo (nunca expulsa uno legítimo).
    pub fn issue(&self, payload: P, decision: Decision) -> Result<String, BrokerFull> {
        let now = self.clock.now();
        let mut g = self.lock();
        g.map.retain(|_, e| e.expires > now);
        if g.map.len() >= MAX_PENDING {
            return Err(BrokerFull);
        }
        let id = Uuid::now_v7().to_string();
        g.map.insert(
            id.clone(),
            Entry {
                payload,
                decision,
                expires: now + TICKET_TTL,
                attempts: 0,
            },
        );
        Ok(id)
    }

    /// Canjea el ticket: lo consume atómicamente si la confirmación es válida.
    pub fn redeem(&self, ticket: &str, typed: Option<&str>) -> Result<(P, Decision), RedeemError> {
        let now = self.clock.now();
        let mut g = self.lock();
        let Some(entry) = g.map.get_mut(ticket) else {
            return Err(RedeemError::Invalid);
        };
        if entry.expires <= now {
            g.map.remove(ticket);
            return Err(RedeemError::Expired);
        }
        if !entry.decision.accepts(typed) {
            entry.attempts += 1;
            if entry.attempts >= MAX_TYPED_ATTEMPTS {
                g.map.remove(ticket);
            }
            return Err(RedeemError::TypedMismatch);
        }
        match g.map.remove(ticket) {
            Some(e) => Ok((e.payload, e.decision)),
            None => Err(RedeemError::Invalid),
        }
    }

    pub fn cancel(&self, ticket: &str) -> bool {
        self.lock().map.remove(ticket).is_some()
    }

    /// Invalida todos (cierre de ventana, cambio de conexión).
    pub fn clear(&self) {
        self.lock().map.clear();
    }

    pub fn pending(&self) -> usize {
        self.lock().map.len()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    /// Reloj manual para tests.
    #[derive(Default)]
    pub struct FakeClock(AtomicU64);

    impl FakeClock {
        pub fn advance(&self, d: Duration) {
            self.0.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.0.load(Ordering::SeqCst))
        }
    }

    fn broker() -> (Broker<u32>, Arc<FakeClock>) {
        let c = Arc::new(FakeClock::default());
        (Broker::new(c.clone()), c)
    }

    #[test]
    fn un_solo_uso() {
        let (b, _) = broker();
        let t = b.issue(7, Decision::Confirm).expect("cupo");
        assert_eq!(b.redeem(&t, None).map(|(p, _)| p), Ok(7));
        assert_eq!(b.redeem(&t, None).err(), Some(RedeemError::Invalid));
    }

    #[test]
    fn expira_a_los_120_s() {
        let (b, c) = broker();
        let t = b.issue(1, Decision::Confirm).expect("cupo");
        c.advance(Duration::from_secs(119));
        let t2 = b.issue(2, Decision::Confirm).expect("cupo");
        assert!(b.redeem(&t, None).is_ok());
        c.advance(Duration::from_secs(121));
        assert_eq!(b.redeem(&t2, None).err(), Some(RedeemError::Expired));
        assert_eq!(b.redeem(&t2, None).err(), Some(RedeemError::Invalid));
    }

    #[test]
    fn typed_mal_no_consume_y_cinco_fallos_invalidan() {
        let (b, _) = broker();
        let dec = Decision::ConfirmTyped {
            expected: "datos".into(),
        };
        let t = b.issue(1, dec.clone()).expect("cupo");
        for _ in 0..4 {
            assert_eq!(
                b.redeem(&t, Some("x")).err(),
                Some(RedeemError::TypedMismatch)
            );
        }
        // Aún vivo: la confirmación correcta funciona.
        assert!(b.redeem(&t, Some("datos")).is_ok());
        let t = b.issue(1, dec).expect("cupo");
        for _ in 0..5 {
            assert_eq!(b.redeem(&t, None).err(), Some(RedeemError::TypedMismatch));
        }
        assert_eq!(
            b.redeem(&t, Some("datos")).err(),
            Some(RedeemError::Invalid)
        );
    }

    #[test]
    fn cap_de_32_rechaza_el_nuevo_y_no_expulsa_los_legitimos() {
        let (b, c) = broker();
        let first = b.issue(0, Decision::Confirm).expect("cupo");
        for i in 1..MAX_PENDING as u32 {
            b.issue(i, Decision::Confirm).expect("cupo");
        }
        assert_eq!(b.pending(), MAX_PENDING);
        // Lleno: el plan nuevo se rechaza y el ticket más viejo sigue vivo.
        assert_eq!(b.issue(99, Decision::Confirm), Err(BrokerFull));
        assert_eq!(b.pending(), MAX_PENDING);
        assert!(b.redeem(&first, None).is_ok());
        // Al liberar un cupo (o expirar) vuelve a aceptar.
        assert!(b.issue(100, Decision::Confirm).is_ok());
        c.advance(Duration::from_secs(121));
        assert!(b.issue(101, Decision::Confirm).is_ok());
        assert_eq!(b.pending(), 1, "los expirados se purgan al emitir");
    }

    #[test]
    fn cancel_y_clear() {
        let (b, _) = broker();
        let t = b.issue(1, Decision::Confirm).expect("cupo");
        assert!(b.cancel(&t));
        assert!(!b.cancel(&t));
        b.issue(2, Decision::Confirm).expect("cupo");
        b.clear();
        assert_eq!(b.pending(), 0);
    }

    #[test]
    fn el_ticket_es_uuid_v7() {
        let (b, _) = broker();
        let t = b.issue(1, Decision::Confirm).expect("cupo");
        let u = Uuid::parse_str(&t).expect("uuid");
        assert_eq!(u.get_version_num(), 7);
    }

    #[test]
    fn limite_exacto_de_expiracion() {
        let (b, c) = broker();
        let t = b.issue(1, Decision::Confirm).expect("cupo");
        c.advance(Duration::from_millis(119_999));
        assert!(b.redeem(&t, None).is_ok());
        let t = b.issue(1, Decision::Confirm).expect("cupo");
        c.advance(TICKET_TTL);
        assert_eq!(b.redeem(&t, None).err(), Some(RedeemError::Expired));
    }

    #[test]
    fn lleno_de_expirados_acepta_uno_nuevo() {
        let (b, c) = broker();
        for i in 0..MAX_PENDING as u32 {
            b.issue(i, Decision::Confirm).expect("cupo");
        }
        c.advance(TICKET_TTL);
        assert!(b.issue(99, Decision::Confirm).is_ok());
        assert_eq!(b.pending(), 1);
    }

    #[test]
    fn deny_nunca_se_canjea_y_cinco_intentos_lo_eliminan() {
        let (b, _) = broker();
        let t = b
            .issue(1, Decision::Deny(crate::policy::DenyReason::Forbidden))
            .expect("cupo");
        for _ in 0..5 {
            assert_eq!(
                b.redeem(&t, Some("x")).err(),
                Some(RedeemError::TypedMismatch)
            );
        }
        assert_eq!(b.redeem(&t, None).err(), Some(RedeemError::Invalid));
    }

    #[test]
    fn lock_envenenado_no_deja_sin_tickets() {
        let c = Arc::new(FakeClock::default());
        let b = Arc::new(Broker::<u32>::new(c));
        let b2 = b.clone();
        let _ = std::thread::spawn(move || {
            let _g = b2.inner.lock().expect("lock");
            panic!("envenenar");
        })
        .join();
        assert!(b.inner.is_poisoned());
        let t = b.issue(1, Decision::Confirm).expect("cupo");
        assert!(b.redeem(&t, None).is_ok());
    }

    #[test]
    fn dos_hilos_canjeando_el_mismo_ticket_solo_uno_gana() {
        for _ in 0..50 {
            let c = Arc::new(FakeClock::default());
            let b = Arc::new(Broker::<u32>::new(c));
            let t = b.issue(1, Decision::Confirm).expect("cupo");
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    let (b, t) = (b.clone(), t.clone());
                    std::thread::spawn(move || b.redeem(&t, None).is_ok())
                })
                .collect();
            let wins = handles
                .into_iter()
                .filter(|_| true)
                .map(|h| h.join().expect("hilo"))
                .filter(|ok| *ok)
                .count();
            assert_eq!(wins, 1);
        }
    }
}
