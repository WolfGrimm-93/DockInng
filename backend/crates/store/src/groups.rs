//! Grupos propios, asignaciones por conexión, colores de stack y migración única desde el
//! `localStorage` del frontend. Toda mutación es una transacción y devuelve el snapshot.

use std::collections::{BTreeMap, HashMap, HashSet};

use engine_core::connections::{
    MAX_ASSIGNMENTS, MAX_GROUPS, is_uuid_v7, validate_display_name, validate_hue,
};
use engine_core::{
    ExportImportReport, Group, GroupAssignment, GroupOp, GroupsSnapshot, LOCAL_CONNECTION_ID,
    LegacyGroups, LegacyImportReport,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;

use crate::error::StoreError;
use crate::{Store, new_id, now_secs};

/// Clave interna (no expuesta por `prefs_set`) que marca la migración como hecha.
pub(crate) const LEGACY_FLAG: &str = "legacy_groups_imported";
/// Máximo de nombres por operación de asignación.
const MAX_NAMES_PER_OP: usize = 500;
/// Tope de contenedores que se envían como «vivos» al limpiar asignaciones huérfanas.
const MAX_LIVE_NAMES: usize = 10_000;
/// Máximo de largo de un nombre de contenedor / proyecto.
const MAX_ITEM_NAME: usize = 255;
/// Paleta de matices para grupos nuevos sin color explícito.
const DEFAULT_HUES: [u16; 12] = [210, 150, 30, 280, 350, 180, 60, 250, 120, 320, 90, 20];

fn invalid<T>(msg: &str) -> Result<T, StoreError> {
    Err(StoreError::InvalidInput(msg.to_string()))
}

/// Nombre de contenedor o de proyecto: no vacío, acotado, sin controles.
fn valid_item_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ITEM_NAME && !s.chars().any(|c| c.is_control())
}

pub(crate) fn is_legacy_imported(conn: &Connection) -> Result<bool, StoreError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM preferences WHERE key = ?1",
            [LEGACY_FLAG],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn load_snapshot(conn: &Connection) -> Result<GroupsSnapshot, StoreError> {
    let mut groups = Vec::new();
    let mut st = conn.prepare("SELECT id, name, hue FROM groups ORDER BY sort, created_at, id")?;
    for row in st.query_map([], |r| {
        Ok(Group {
            id: r.get(0)?,
            name: r.get(1)?,
            hue: r.get::<_, i64>(2)? as u16,
        })
    })? {
        groups.push(row?);
    }
    let mut assignments = Vec::new();
    let mut st = conn.prepare(
        "SELECT connection_id, container_name, group_id FROM group_assignments
         ORDER BY connection_id, container_name",
    )?;
    for row in st.query_map([], |r| {
        Ok(GroupAssignment {
            connection_id: r.get(0)?,
            container_name: r.get(1)?,
            group_id: r.get(2)?,
        })
    })? {
        assignments.push(row?);
    }
    let mut stack_hues = BTreeMap::new();
    let mut st = conn.prepare("SELECT project, hue FROM stack_hues")?;
    for row in st.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u16))
    })? {
        let (p, h) = row?;
        stack_hues.insert(p, h);
    }
    Ok(GroupsSnapshot {
        groups,
        assignments,
        stack_hues,
        legacy_imported: is_legacy_imported(conn)?,
    })
}

fn count(conn: &Connection, table: &str) -> Result<usize, StoreError> {
    // `table` es siempre un literal interno.
    let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
    Ok(n as usize)
}

fn group_exists(tx: &Transaction<'_>, id: &str) -> Result<bool, StoreError> {
    Ok(tx
        .query_row("SELECT 1 FROM groups WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Hay otro grupo con ese nombre (sin distinguir mayúsculas)?
fn name_taken(tx: &Transaction<'_>, name: &str, except: Option<&str>) -> Result<bool, StoreError> {
    let lower = name.to_lowercase();
    let mut st = tx.prepare("SELECT id, name FROM groups")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, n) = row?;
        if Some(id.as_str()) != except && n.to_lowercase() == lower {
            return Ok(true);
        }
    }
    Ok(false)
}

fn pick_hue(tx: &Transaction<'_>) -> Result<u16, StoreError> {
    let mut used = HashSet::new();
    let mut st = tx.prepare("SELECT hue FROM groups")?;
    for h in st.query_map([], |r| r.get::<_, i64>(0))? {
        used.insert(h? as u16);
    }
    let n = used.len();
    Ok(DEFAULT_HUES
        .iter()
        .copied()
        .find(|h| !used.contains(h))
        .unwrap_or(DEFAULT_HUES[n % DEFAULT_HUES.len()]))
}

fn apply_op(tx: &Transaction<'_>, op: GroupOp) -> Result<(), StoreError> {
    match op {
        GroupOp::CreateGroup { name, hue } => {
            let name = validate_display_name(&name)?;
            if count(tx, "groups")? >= MAX_GROUPS {
                return invalid("demasiados grupos");
            }
            if name_taken(tx, &name, None)? {
                return Err(StoreError::Conflict(
                    "ya existe un grupo con ese nombre".into(),
                ));
            }
            let hue = match hue {
                Some(h) => validate_hue(h)?,
                None => pick_hue(tx)?,
            };
            let sort: i64 =
                tx.query_row("SELECT COALESCE(MAX(sort), -1) + 1 FROM groups", [], |r| {
                    r.get(0)
                })?;
            tx.execute(
                "INSERT INTO groups (id, name, hue, sort, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![new_id(), name, hue, sort, now_secs()],
            )?;
        }
        GroupOp::RenameGroup { id, name } => {
            let name = validate_display_name(&name)?;
            if !group_exists(tx, &id)? {
                return Err(StoreError::NotFound("grupo".into()));
            }
            if name_taken(tx, &name, Some(&id))? {
                return Err(StoreError::Conflict(
                    "ya existe un grupo con ese nombre".into(),
                ));
            }
            tx.execute(
                "UPDATE groups SET name = ?1 WHERE id = ?2",
                params![name, id],
            )?;
        }
        GroupOp::SetGroupHue { id, hue } => {
            let hue = validate_hue(hue)?;
            let n = tx.execute("UPDATE groups SET hue = ?1 WHERE id = ?2", params![hue, id])?;
            if n == 0 {
                return Err(StoreError::NotFound("grupo".into()));
            }
        }
        GroupOp::DeleteGroup { id } => {
            // Las asignaciones caen por `ON DELETE CASCADE`.
            tx.execute("DELETE FROM groups WHERE id = ?1", [id])?;
        }
        GroupOp::Assign {
            connection_id,
            names,
            group_id,
        } => {
            if names.len() > MAX_NAMES_PER_OP {
                return invalid("demasiados contenedores en una sola operación");
            }
            if names.iter().any(|n| !valid_item_name(n)) {
                return invalid("nombre de contenedor inválido");
            }
            let conn_ok = tx
                .query_row(
                    "SELECT 1 FROM connections WHERE id = ?1",
                    [&connection_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !conn_ok {
                return Err(StoreError::NotFound("conexión".into()));
            }
            match group_id {
                Some(gid) => {
                    if !group_exists(tx, &gid)? {
                        return Err(StoreError::NotFound("grupo".into()));
                    }
                    for n in &names {
                        tx.execute(
                            "INSERT INTO group_assignments (connection_id, container_name, group_id)
                             VALUES (?1, ?2, ?3)
                             ON CONFLICT(connection_id, container_name) DO UPDATE SET group_id = excluded.group_id",
                            params![connection_id, n, gid],
                        )?;
                    }
                    if count(tx, "group_assignments")? > MAX_ASSIGNMENTS {
                        return invalid("demasiadas asignaciones de grupo");
                    }
                }
                None => {
                    for n in &names {
                        tx.execute(
                            "DELETE FROM group_assignments WHERE connection_id = ?1 AND container_name = ?2",
                            params![connection_id, n],
                        )?;
                    }
                }
            }
        }
        GroupOp::PruneAssignments {
            connection_id,
            live_names,
        } => {
            if live_names.len() > MAX_LIVE_NAMES {
                return invalid("demasiados contenedores para limpiar asignaciones");
            }
            let conn_ok = tx
                .query_row(
                    "SELECT 1 FROM connections WHERE id = ?1",
                    [&connection_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !conn_ok {
                return Err(StoreError::NotFound("conexión".into()));
            }
            let vivos: HashSet<&str> = live_names.iter().map(String::as_str).collect();
            let existentes: Vec<String> = {
                let mut st = tx.prepare(
                    "SELECT container_name FROM group_assignments WHERE connection_id = ?1",
                )?;
                let filas = st.query_map([&connection_id], |r| r.get::<_, String>(0))?;
                filas.collect::<Result<_, _>>()?
            };
            for n in existentes.iter().filter(|n| !vivos.contains(n.as_str())) {
                tx.execute(
                    "DELETE FROM group_assignments WHERE connection_id = ?1 AND container_name = ?2",
                    params![connection_id, n],
                )?;
            }
        }
        GroupOp::SetStackHue { project, hue } => {
            if !valid_item_name(&project) {
                return invalid("nombre de proyecto inválido");
            }
            match hue {
                Some(h) => {
                    let h = validate_hue(h)?;
                    tx.execute(
                        "INSERT INTO stack_hues (project, hue) VALUES (?1, ?2)
                         ON CONFLICT(project) DO UPDATE SET hue = excluded.hue",
                        params![project, h],
                    )?;
                }
                None => {
                    tx.execute("DELETE FROM stack_hues WHERE project = ?1", [project])?;
                }
            }
        }
    }
    Ok(())
}

impl Store {
    /// Estado completo de grupos.
    pub fn groups_load(&self) -> Result<GroupsSnapshot, StoreError> {
        load_snapshot(&self.lock())
    }

    /// Aplica una mutación de forma atómica y devuelve el snapshot resultante.
    pub fn groups_mutate(&self, op: GroupOp) -> Result<GroupsSnapshot, StoreError> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        apply_op(&tx, op)?;
        tx.commit()?;
        load_snapshot(&conn)
    }

    /// Migración única e idempotente desde el `localStorage` del frontend. Revalida todo, regenera
    /// ids que no sean UUID v7 y descarta (contando) lo que no encaje. Una sola transacción.
    /// Importa un documento de `groups_export` en UNA transacción: los grupos con el mismo nombre
    /// se reutilizan; las asignaciones de conexiones que no existen aquí se descartan. Si algo grave
    /// falla (p. ej. se superan los límites), no se escribe nada.
    pub fn groups_import_export(&self, doc: &Value) -> Result<ExportImportReport, StoreError> {
        let obj = doc.as_object().ok_or_else(|| {
            StoreError::InvalidInput("el archivo no es un documento de grupos".into())
        })?;
        if obj.get("format").and_then(Value::as_str) != Some("dockinng-groups")
            || obj.get("version").and_then(Value::as_i64) != Some(1)
        {
            return invalid("formato o versión de grupos no soportados");
        }
        let grupos = obj.get("groups").and_then(Value::as_array);
        let grupos =
            grupos.ok_or_else(|| StoreError::InvalidInput("falta la lista de grupos".into()))?;
        let asignaciones = obj
            .get("assignments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if grupos.len() > MAX_GROUPS || asignaciones.len() > MAX_ASSIGNMENTS {
            return invalid("el archivo supera los límites de grupos o asignaciones");
        }
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let mut rep = ExportImportReport::default();
        // Id del grupo en el archivo (o su nombre, si no lo trae) -> id real aquí.
        let mut mapa: HashMap<String, String> = HashMap::new();
        for g in grupos {
            let name = g
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| StoreError::InvalidInput("grupo sin nombre".into()))?;
            let hue = g.get("hue").and_then(Value::as_i64);
            let buscar = |tx: &Transaction<'_>| -> Result<Option<String>, StoreError> {
                Ok(tx
                    .query_row(
                        "SELECT id FROM groups WHERE lower(name) = lower(?1)",
                        [name.trim()],
                        |r| r.get(0),
                    )
                    .optional()?)
            };
            let id = match buscar(&tx)? {
                Some(id) => {
                    rep.groups_reused += 1;
                    id
                }
                None => {
                    apply_op(
                        &tx,
                        GroupOp::CreateGroup {
                            name: name.to_string(),
                            hue,
                        },
                    )?;
                    rep.groups_created += 1;
                    buscar(&tx)?
                        .ok_or_else(|| StoreError::NotFound("grupo recién creado".into()))?
                }
            };
            if let Some(viejo) = g.get("id").and_then(Value::as_str) {
                mapa.insert(viejo.to_string(), id.clone());
            }
            mapa.entry(name.to_string()).or_insert(id);
        }
        for a in &asignaciones {
            let conexion = a
                .get("connection_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let nombre = a
                .get("container_name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let destino = a
                .get("group_id")
                .and_then(Value::as_str)
                .and_then(|g| mapa.get(g));
            let conexion_ok = !conexion.is_empty()
                && tx
                    .query_row(
                        "SELECT 1 FROM connections WHERE id = ?1",
                        [conexion],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
            let Some(gid) = destino.filter(|_| conexion_ok && !nombre.is_empty()) else {
                rep.assignments_skipped += 1;
                continue;
            };
            match apply_op(
                &tx,
                GroupOp::Assign {
                    connection_id: conexion.to_string(),
                    names: vec![nombre.to_string()],
                    group_id: Some(gid.clone()),
                },
            ) {
                Ok(()) => rep.assignments_imported += 1,
                Err(StoreError::InvalidInput(_)) => rep.assignments_skipped += 1,
                Err(e) => return Err(e),
            }
        }
        if let Some(colores) = obj.get("stack_hues").and_then(Value::as_object) {
            for (proyecto, hue) in colores {
                let Some(hue) = hue.as_i64() else { continue };
                match apply_op(
                    &tx,
                    GroupOp::SetStackHue {
                        project: proyecto.clone(),
                        hue: Some(hue),
                    },
                ) {
                    Ok(()) => rep.stack_hues_imported += 1,
                    Err(StoreError::InvalidInput(_)) => {}
                    Err(e) => return Err(e),
                }
            }
        }
        tx.commit()?;
        Ok(rep)
    }

    pub fn groups_import_legacy(
        &self,
        payload: LegacyGroups,
    ) -> Result<LegacyImportReport, StoreError> {
        let mut conn = self.lock();
        if is_legacy_imported(&conn)? {
            return Ok(LegacyImportReport {
                already_imported: true,
                snapshot: load_snapshot(&conn)?,
                ..Default::default()
            });
        }
        if payload.v != 1 {
            return invalid("versión de datos de grupos no soportada");
        }
        if payload.groups.len() > MAX_GROUPS || payload.assign.len() > MAX_ASSIGNMENTS {
            return invalid("los datos de grupos exceden los límites");
        }
        let tx = conn.transaction()?;
        // Estado previo (normalmente vacío): los nombres existentes cuentan como tomados.
        let mut id_map: HashMap<String, String> = HashMap::new();
        let mut used_ids: HashSet<String> = HashSet::new();
        let mut imported_groups = 0u32;
        let mut sort: i64 =
            tx.query_row("SELECT COALESCE(MAX(sort), -1) + 1 FROM groups", [], |r| {
                r.get(0)
            })?;
        for g in &payload.groups {
            let Ok(name) = validate_display_name(&g.name) else {
                continue;
            };
            if id_map.contains_key(&g.id) {
                continue;
            }
            // Nombre duplicado (sin distinguir mayúsculas): las asignaciones van al ya importado.
            if name_taken(&tx, &name, None)? {
                let existing: Option<String> = {
                    let lower = name.to_lowercase();
                    let mut st = tx.prepare("SELECT id, name FROM groups")?;
                    let rows =
                        st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                    let mut found = None;
                    for row in rows {
                        let (id, n) = row?;
                        if n.to_lowercase() == lower {
                            found = Some(id);
                            break;
                        }
                    }
                    found
                };
                if let Some(e) = existing {
                    id_map.insert(g.id.clone(), e);
                }
                continue;
            }
            let hue = g.hue.rem_euclid(360) as u16;
            let mut new = if is_uuid_v7(&g.id) {
                g.id.clone()
            } else {
                new_id()
            };
            if used_ids.contains(&new) {
                new = new_id();
            }
            // Un id v7 ya presente en la base (no debería): se regenera.
            if group_exists(&tx, &new)? {
                new = new_id();
            }
            tx.execute(
                "INSERT INTO groups (id, name, hue, sort, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![new, name, hue, sort, now_secs()],
            )?;
            sort += 1;
            used_ids.insert(new.clone());
            id_map.insert(g.id.clone(), new);
            imported_groups += 1;
        }
        let (mut imported_assignments, mut dropped) = (0u32, 0u32);
        for (key, old_group) in &payload.assign {
            let mapped = key
                .split_once('\0')
                .filter(|(p, c)| valid_item_name(c) && (*p == LOCAL_CONNECTION_ID || is_uuid_v7(p)))
                .and_then(|(p, c)| id_map.get(old_group).map(|g| (p, c, g)));
            let Some((profile, container, group)) = mapped else {
                dropped += 1;
                continue;
            };
            let conn_ok = tx
                .query_row("SELECT 1 FROM connections WHERE id = ?1", [profile], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            if !conn_ok {
                dropped += 1;
                continue;
            }
            tx.execute(
                "INSERT INTO group_assignments (connection_id, container_name, group_id)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(connection_id, container_name) DO UPDATE SET group_id = excluded.group_id",
                params![profile, container, group],
            )?;
            imported_assignments += 1;
        }
        for (project, hue) in &payload.stack_hue {
            if !valid_item_name(project) {
                continue;
            }
            tx.execute(
                "INSERT INTO stack_hues (project, hue) VALUES (?1, ?2)
                 ON CONFLICT(project) DO UPDATE SET hue = excluded.hue",
                params![project, hue.rem_euclid(360)],
            )?;
        }
        tx.execute(
            "INSERT INTO preferences (key, value_json, updated_at) VALUES (?1, '1', ?2)",
            params![LEGACY_FLAG, now_secs()],
        )?;
        tx.commit()?;
        Ok(LegacyImportReport {
            already_imported: false,
            imported_groups,
            imported_assignments,
            dropped_assignments: dropped,
            snapshot: load_snapshot(&conn)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use engine_core::LegacyGroup;

    fn store() -> (TempDir, Store) {
        let t = TempDir::new("groups");
        let s = Store::open(&t.0.join("d")).unwrap();
        (t, s)
    }

    fn create(s: &Store, name: &str) -> Result<GroupsSnapshot, StoreError> {
        s.groups_mutate(GroupOp::CreateGroup {
            name: name.into(),
            hue: None,
        })
    }

    #[test]
    fn crear_renombrar_colorear_borrar() {
        let (_t, s) = store();
        let snap = create(&s, " Web ").unwrap();
        assert_eq!(snap.groups.len(), 1);
        assert_eq!(snap.groups[0].name, "Web");
        assert!(is_uuid_v7(&snap.groups[0].id));
        let id = snap.groups[0].id.clone();
        // Duplicado sin distinguir mayúsculas.
        assert!(matches!(create(&s, "wEB"), Err(StoreError::Conflict(_))));
        let snap = s
            .groups_mutate(GroupOp::RenameGroup {
                id: id.clone(),
                name: "API".into(),
            })
            .unwrap();
        assert_eq!(snap.groups[0].name, "API");
        let snap = s
            .groups_mutate(GroupOp::SetGroupHue {
                id: id.clone(),
                hue: 200,
            })
            .unwrap();
        assert_eq!(snap.groups[0].hue, 200);
        assert!(
            s.groups_mutate(GroupOp::SetGroupHue {
                id: id.clone(),
                hue: 360
            })
            .is_err()
        );
        let snap = s.groups_mutate(GroupOp::DeleteGroup { id }).unwrap();
        assert!(snap.groups.is_empty());
    }

    #[test]
    fn validaciones_de_nombre_y_limites() {
        let (_t, s) = store();
        assert!(create(&s, "").is_err());
        assert!(create(&s, &"x".repeat(41)).is_err());
        assert!(create(&s, "a\u{202e}b").is_err());
        for i in 0..MAX_GROUPS {
            create(&s, &format!("g{i}")).unwrap();
        }
        assert!(create(&s, "uno-mas").is_err());
    }

    #[test]
    fn asignar_mover_y_quitar() {
        let (_t, s) = store();
        let g = create(&s, "A").unwrap().groups[0].id.clone();
        let snap = s
            .groups_mutate(GroupOp::Assign {
                connection_id: "local".into(),
                names: vec!["web".into(), "db".into()],
                group_id: Some(g.clone()),
            })
            .unwrap();
        assert_eq!(snap.assignments.len(), 2);
        let snap = s
            .groups_mutate(GroupOp::Assign {
                connection_id: "local".into(),
                names: vec!["web".into()],
                group_id: None,
            })
            .unwrap();
        assert_eq!(snap.assignments.len(), 1);
        // Conexión y grupo inexistentes.
        assert!(matches!(
            s.groups_mutate(GroupOp::Assign {
                connection_id: "nope".into(),
                names: vec!["x".into()],
                group_id: Some(g.clone())
            }),
            Err(StoreError::NotFound(_))
        ));
        assert!(matches!(
            s.groups_mutate(GroupOp::Assign {
                connection_id: "local".into(),
                names: vec!["x".into()],
                group_id: Some("no-existe".into())
            }),
            Err(StoreError::NotFound(_))
        ));
        // Borrar el grupo borra sus asignaciones.
        let snap = s.groups_mutate(GroupOp::DeleteGroup { id: g }).unwrap();
        assert!(snap.assignments.is_empty());
    }

    #[test]
    fn matiz_de_stack() {
        let (_t, s) = store();
        let snap = s
            .groups_mutate(GroupOp::SetStackHue {
                project: "p".into(),
                hue: Some(40),
            })
            .unwrap();
        assert_eq!(snap.stack_hues["p"], 40);
        let snap = s
            .groups_mutate(GroupOp::SetStackHue {
                project: "p".into(),
                hue: None,
            })
            .unwrap();
        assert!(snap.stack_hues.is_empty());
    }

    fn legacy(json: serde_json::Value) -> LegacyGroups {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn import_legacy_idempotente_y_regenera_ids() {
        let (_t, s) = store();
        let good = uuid::Uuid::now_v7().to_string();
        let p = legacy(serde_json::json!({
            "v": 1,
            "groups": [
                {"id": good, "name": "Uno", "hue": 10},
                {"id": "no-v7", "name": "Dos", "hue": 725},
                {"id": "x3", "name": "uno", "hue": 5},
                {"id": "x4", "name": "", "hue": 5}
            ],
            "assign": {
                "local\u{0}web": good,
                "local\u{0}db": "no-v7",
                "local\u{0}dup": "x3",
                "otra\u{0}web": good,
                "local\u{0}fantasma": "no-existe",
                "sin-separador": good
            },
            "stackHue": {"proj": 200, "malo\u{1}": 1}
        }));
        let r = s.groups_import_legacy(p.clone()).unwrap();
        assert!(!r.already_imported);
        assert_eq!(r.imported_groups, 2);
        assert_eq!(r.imported_assignments, 3);
        assert_eq!(r.dropped_assignments, 3);
        let snap = &r.snapshot;
        assert!(snap.legacy_imported);
        assert_eq!(snap.groups.len(), 2);
        assert!(snap.groups.iter().all(|g| is_uuid_v7(&g.id)));
        assert_eq!(
            snap.groups.iter().find(|g| g.name == "Uno").unwrap().id,
            good
        );
        assert_eq!(snap.groups.iter().find(|g| g.name == "Dos").unwrap().hue, 5);
        assert_eq!(snap.stack_hues.len(), 1);
        // Segunda llamada: no escribe ni duplica.
        let r2 = s.groups_import_legacy(p).unwrap();
        assert!(r2.already_imported);
        assert_eq!(r2.snapshot, r.snapshot);
    }

    #[test]
    fn import_legacy_rechaza_version_y_limites() {
        let (_t, s) = store();
        assert!(
            s.groups_import_legacy(legacy(serde_json::json!({"v": 2, "groups": []})))
                .is_err()
        );
        let many: Vec<LegacyGroup> = (0..=MAX_GROUPS)
            .map(|i| LegacyGroup {
                id: format!("g{i}"),
                name: format!("n{i}"),
                hue: 1,
            })
            .collect();
        let p = LegacyGroups {
            v: 1,
            groups: many,
            assign: BTreeMap::new(),
            stack_hue: BTreeMap::new(),
        };
        assert!(s.groups_import_legacy(p).is_err());
        // Un rechazo no marca la migración como hecha.
        assert!(!s.groups_load().unwrap().legacy_imported);
    }

    #[test]
    fn import_conserva_el_mapa_exacto() {
        let (_t, s) = store();
        let ids: Vec<String> = (0..5).map(|_| uuid::Uuid::now_v7().to_string()).collect();
        let groups: Vec<serde_json::Value> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| serde_json::json!({"id": id, "name": format!("G{i}"), "hue": i * 50}))
            .collect();
        let mut assign = serde_json::Map::new();
        for c in 0..40 {
            assign.insert(format!("local\u{0}c{c}"), serde_json::json!(ids[c % 5]));
        }
        let r = s
            .groups_import_legacy(legacy(
                serde_json::json!({"v":1,"groups":groups,"assign":assign,"stackHue":{}}),
            ))
            .unwrap();
        assert_eq!(r.snapshot.assignments.len(), 40);
        for a in &r.snapshot.assignments {
            let c: usize = a.container_name[1..].parse().unwrap();
            assert_eq!(a.group_id, ids[c % 5]);
        }
    }

    #[test]
    fn hilos_concurrentes_no_pierden_datos() {
        let (_t, s) = store();
        let s = std::sync::Arc::new(s);
        let hs: Vec<_> = (0..2)
            .map(|t| {
                let s = s.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        create(&s, &format!("t{t}-{i}")).unwrap();
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        assert_eq!(s.groups_load().unwrap().groups.len(), 50);
    }

    #[test]
    fn todo_id_generado_es_v7() {
        let (_t, s) = store();
        for i in 0..20 {
            create(&s, &format!("g{i}")).unwrap();
        }
        let snap = s.groups_load().unwrap();
        assert!(
            snap.groups
                .iter()
                .all(|g| { uuid::Uuid::parse_str(&g.id).unwrap().get_version_num() == 7 })
        );
    }

    #[test]
    fn limpiar_huerfanos_quita_solo_los_que_ya_no_existen() {
        let d = std::env::temp_dir().join(format!("dockinng-test-prune-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&d).unwrap();
        let s = Store::open(&d.join("store.db")).unwrap();
        let g = s
            .groups_mutate(GroupOp::CreateGroup {
                name: "API".into(),
                hue: None,
            })
            .unwrap()
            .groups[0]
            .id
            .clone();
        s.groups_mutate(GroupOp::Assign {
            connection_id: "local".into(),
            names: vec!["web".into(), "db".into(), "viejo".into()],
            group_id: Some(g.clone()),
        })
        .unwrap();
        let snap = s
            .groups_mutate(GroupOp::PruneAssignments {
                connection_id: "local".into(),
                live_names: vec!["web".into(), "db".into()],
            })
            .unwrap();
        let mut nombres: Vec<&str> = snap
            .assignments
            .iter()
            .map(|a| a.container_name.as_str())
            .collect();
        nombres.sort_unstable();
        assert_eq!(nombres, vec!["db", "web"]);
        // Conexión inexistente: se rechaza sin tocar nada.
        assert!(
            s.groups_mutate(GroupOp::PruneAssignments {
                connection_id: "no-existe".into(),
                live_names: vec![],
            })
            .is_err()
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn importar_export_fusiona_sin_duplicar_y_descarta_conexiones_ajenas() {
        let d = std::env::temp_dir().join(format!("dockinng-test-imp-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&d).unwrap();
        let s = Store::open(&d.join("store.db")).unwrap();
        let doc = serde_json::json!({
            "format": "dockinng-groups", "version": 1,
            "groups": [{"id": "viejo-1", "name": "API", "hue": 200}],
            "assignments": [
                {"connection_id": "local", "container_name": "web", "group_id": "viejo-1"},
                {"connection_id": "otra-maquina", "container_name": "db", "group_id": "viejo-1"}
            ],
            "stack_hues": {"shop": 120}
        });
        let primera = s.groups_import_export(&doc).unwrap();
        assert_eq!((primera.groups_created, primera.groups_reused), (1, 0));
        assert_eq!(
            (primera.assignments_imported, primera.assignments_skipped),
            (1, 1)
        );
        assert_eq!(primera.stack_hues_imported, 1);
        // Segunda importación: el grupo se reutiliza, no se duplica.
        let segunda = s.groups_import_export(&doc).unwrap();
        assert_eq!((segunda.groups_created, segunda.groups_reused), (0, 1));
        let snap = s.groups_load().unwrap();
        assert_eq!(snap.groups.len(), 1);
        // Formato ajeno: se rechaza sin tocar nada.
        assert!(
            s.groups_import_export(
                &serde_json::json!({"format": "otro", "version": 1, "groups": []})
            )
            .is_err()
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
