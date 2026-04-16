use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use time::OffsetDateTime;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEventPayload {
    pub event_id: String,
    pub user_id: String,
    pub device_id: String,
    pub occurred_at: String,
    pub recorded_at: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub activity_id: Option<String>,
    pub department_id: Option<String>,
    pub note: Option<String>,
    pub idempotency_key: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxStatus {
    pub pending_count: usize,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncBatchPayload {
    batch_id: String,
    user_id: String,
    device_id: String,
    sent_at: String,
    events: Vec<ActivityEventPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncAckPayload {
    accepted_event_ids: Vec<String>,
    duplicate_event_ids: Vec<String>,
    received_at: String,
}

#[derive(Clone)]
struct PendingEvent {
    event_id: String,
    user_id: String,
    device_id: String,
    payload: ActivityEventPayload,
}

pub fn queue_event(
    app: &AppHandle,
    user_id: &str,
    event: ActivityEventPayload,
) -> Result<OutboxStatus, String> {
    if event.user_id != user_id {
        return Err(String::from(
            "Queued event userId did not match the selected desktop user.",
        ));
    }

    let connection = open_connection(app, user_id)?;
    initialize_schema(&connection)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO outbox_events (
                event_id,
                user_id,
                device_id,
                occurred_at,
                queued_at,
                payload_json,
                synced_at,
                last_error
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
            params![
                event.event_id,
                user_id,
                event.device_id,
                event.occurred_at,
                timestamp_now_string()?,
                serde_json::to_string(&event).map_err(|error| error.to_string())?
            ],
        )
        .map_err(|error| error.to_string())?;

    read_status(&connection, user_id)
}

pub fn get_status(app: &AppHandle, user_id: &str) -> Result<OutboxStatus, String> {
    let connection = open_connection(app, user_id)?;
    initialize_schema(&connection)?;
    read_status(&connection, user_id)
}

pub async fn flush_outbox(
    app: &AppHandle,
    api_base_url: &str,
    user_id: &str,
) -> Result<OutboxStatus, String> {
    let pending_events = {
        let connection = open_connection(app, user_id)?;
        initialize_schema(&connection)?;
        load_pending_events(&connection, user_id)?
    };

    if pending_events.is_empty() {
        return get_status(app, user_id);
    }

    let client = Client::new();
    let endpoint = format!("{}/v1/sync-batches", api_base_url.trim_end_matches('/'));

    for (device_id, events) in group_events_by_device(pending_events) {
        let batch = SyncBatchPayload {
            batch_id: create_batch_id(user_id, &device_id),
            user_id: user_id.to_string(),
            device_id: device_id.clone(),
            sent_at: timestamp_now_string()?,
            events: events.iter().map(|event| event.payload.clone()).collect(),
        };

        let response = client
            .post(&endpoint)
            .json(&batch)
            .send()
            .await
            .map_err(|error| error.to_string())?;

        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            let reason = if body.trim().is_empty() {
                format!("Sync failed with status {}.", response.status())
            } else {
                body
            };

            let connection = open_connection(app, user_id)?;
            initialize_schema(&connection)?;
            set_pending_error(&connection, user_id, &reason)?;
            return read_status(&connection, user_id);
        }

        let acknowledgment = response
            .json::<SyncAckPayload>()
            .await
            .map_err(|error| error.to_string())?;
        let mut acknowledged_ids = acknowledgment.accepted_event_ids;
        acknowledged_ids.extend(acknowledgment.duplicate_event_ids);

        let connection = open_connection(app, user_id)?;
        initialize_schema(&connection)?;
        mark_events_synced(&connection, &acknowledgment.received_at, &acknowledged_ids)?;
    }

    get_status(app, user_id)
}

fn group_events_by_device(events: Vec<PendingEvent>) -> BTreeMap<String, Vec<PendingEvent>> {
    let mut grouped = BTreeMap::new();

    for event in events {
        grouped
            .entry(event.device_id.clone())
            .or_insert_with(Vec::new)
            .push(event);
    }

    grouped
}

fn open_connection(app: &AppHandle, user_id: &str) -> Result<Connection, String> {
    let database_path = database_path(app, user_id)?;
    Connection::open(database_path).map_err(|error| error.to_string())
}

fn database_path(app: &AppHandle, user_id: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("outbox");

    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    Ok(directory.join(format!("{}.sqlite3", sanitize_id(user_id))))
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS outbox_events (
                event_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                queued_at TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                synced_at TEXT,
                last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_outbox_events_user_pending
            ON outbox_events(user_id, synced_at, queued_at);
            ",
        )
        .map_err(|error| error.to_string())
}

fn load_pending_events(
    connection: &Connection,
    user_id: &str,
) -> Result<Vec<PendingEvent>, String> {
    let mut statement = connection
        .prepare(
            "SELECT event_id, user_id, device_id, payload_json
             FROM outbox_events
             WHERE user_id = ?1 AND synced_at IS NULL
             ORDER BY queued_at ASC",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![user_id], |row| {
            let payload_json: String = row.get(3)?;
            let payload: ActivityEventPayload =
                serde_json::from_str(&payload_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        payload_json.len(),
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;

            Ok(PendingEvent {
                event_id: row.get(0)?,
                user_id: row.get(1)?,
                device_id: row.get(2)?,
                payload,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn mark_events_synced(
    connection: &Connection,
    received_at: &str,
    event_ids: &[String],
) -> Result<(), String> {
    if event_ids.is_empty() {
        return Ok(());
    }

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;

    for event_id in event_ids {
        transaction
            .execute(
                "UPDATE outbox_events
                 SET synced_at = ?1, last_error = NULL
                 WHERE event_id = ?2",
                params![received_at, event_id],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())
}

fn set_pending_error(connection: &Connection, user_id: &str, message: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE outbox_events
             SET last_error = ?1
             WHERE user_id = ?2 AND synced_at IS NULL",
            params![message, user_id],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn read_status(connection: &Connection, user_id: &str) -> Result<OutboxStatus, String> {
    let pending_count = connection
        .query_row(
            "SELECT COUNT(*)
             FROM outbox_events
             WHERE user_id = ?1 AND synced_at IS NULL",
            params![user_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())? as usize;

    let last_synced_at = connection
        .query_row(
            "SELECT MAX(synced_at)
             FROM outbox_events
             WHERE user_id = ?1",
            params![user_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|error| error.to_string())?;

    let last_error = connection
        .query_row(
            "SELECT last_error
             FROM outbox_events
             WHERE user_id = ?1 AND synced_at IS NULL AND last_error IS NOT NULL
             ORDER BY queued_at DESC
             LIMIT 1",
            params![user_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    Ok(OutboxStatus {
        pending_count,
        last_synced_at,
        last_error,
    })
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn create_batch_id(user_id: &str, device_id: &str) -> String {
    format!(
        "native-batch-{}-{}-{}",
        sanitize_id(user_id),
        sanitize_id(device_id),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn timestamp_now_string() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| error.to_string())
}
