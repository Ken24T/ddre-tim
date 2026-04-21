use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub department_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    device_id: String,
    payload: ActivityEventPayload,
}

pub fn queue_event(
    app: &AppHandle,
    user_id: &str,
    event: ActivityEventPayload,
) -> Result<OutboxStatus, String> {
    let data_dir = app_local_data_dir(app)?;
    queue_event_in_data_dir(&data_dir, user_id, event)
}

fn queue_event_in_data_dir(
    data_dir: &Path,
    user_id: &str,
    event: ActivityEventPayload,
) -> Result<OutboxStatus, String> {
    if event.user_id != user_id {
        return Err(String::from(
            "Queued event userId did not match the selected desktop user.",
        ));
    }

    let connection = open_connection_in_data_dir(data_dir, user_id)?;
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
    let data_dir = app_local_data_dir(app)?;
    get_status_in_data_dir(&data_dir, user_id)
}

fn get_status_in_data_dir(data_dir: &Path, user_id: &str) -> Result<OutboxStatus, String> {
    let connection = open_connection_in_data_dir(data_dir, user_id)?;
    initialize_schema(&connection)?;
    read_status(&connection, user_id)
}

pub async fn flush_outbox(
    app: &AppHandle,
    api_base_url: &str,
    user_id: &str,
) -> Result<OutboxStatus, String> {
    let data_dir = app_local_data_dir(app)?;
    flush_outbox_in_data_dir(&data_dir, api_base_url, user_id).await
}

async fn flush_outbox_in_data_dir(
    data_dir: &Path,
    api_base_url: &str,
    user_id: &str,
) -> Result<OutboxStatus, String> {
    let pending_events = {
        let connection = open_connection_in_data_dir(data_dir, user_id)?;
        initialize_schema(&connection)?;
        load_pending_events(&connection, user_id)?
    };

    if pending_events.is_empty() {
        return get_status_in_data_dir(data_dir, user_id);
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
        let response_status = response.status();

        if !response_status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let reason = if body.trim().is_empty() {
                format!("Sync failed with status {}.", response_status)
            } else {
                body
            };

            let connection = open_connection_in_data_dir(data_dir, user_id)?;
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

        let connection = open_connection_in_data_dir(data_dir, user_id)?;
        initialize_schema(&connection)?;
        mark_events_synced(&connection, &acknowledgment.received_at, &acknowledged_ids)?;
    }

    get_status_in_data_dir(data_dir, user_id)
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

fn open_connection_in_data_dir(data_dir: &Path, user_id: &str) -> Result<Connection, String> {
    let database_path = database_path_in_data_dir(data_dir, user_id)?;
    Connection::open(database_path).map_err(|error| error.to_string())
}

fn app_local_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .canonicalize()
        .or_else(|_| {
            app.path()
                .app_local_data_dir()
                .map_err(|error| error.to_string())
        })
}

fn database_path_in_data_dir(data_dir: &Path, user_id: &str) -> Result<PathBuf, String> {
    let directory = data_dir.join("outbox");

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
            let _event_id: String = row.get(0)?;
            let _user_id: String = row.get(1)?;
            let device_id: String = row.get(2)?;

            Ok(PendingEvent { device_id, payload })
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        sync::mpsc::Receiver,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn queue_event_persists_pending_status() {
        let data_dir = make_test_data_dir("queue");
        let user_id = "cinnamon-local-user";
        let event = sample_activity_event(user_id, "event-queued");

        let status = queue_event_in_data_dir(&data_dir, user_id, event).expect("queue should succeed");

        assert_eq!(status.pending_count, 1);
        assert_eq!(status.last_synced_at, None);
        assert_eq!(status.last_error, None);

        let database_path = database_path_in_data_dir(&data_dir, user_id).expect("database path should resolve");
        assert!(database_path.exists(), "outbox database should exist after queueing an event");
    }

    #[test]
    fn flush_outbox_marks_events_synced_after_api_accepts_batch() {
        let data_dir = make_test_data_dir("flush-success");
        let user_id = "cinnamon-local-user";
        let event = sample_activity_event(user_id, "event-success");
        queue_event_in_data_dir(&data_dir, user_id, event).expect("queue should succeed");

        let (api_base_url, request_body_rx, server_thread) = spawn_mock_sync_server(
            "202 Accepted",
            r#"{"batchId":"native-batch-test","acceptedEventIds":["event-success"],"duplicateEventIds":[],"receivedAt":"2026-04-21T12:00:00Z"}"#,
        );

        let status = tauri::async_runtime::block_on(flush_outbox_in_data_dir(&data_dir, &api_base_url, user_id))
            .expect("flush should succeed");

        let request_body = request_body_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("server should receive the sync batch payload");
        let posted_batch: Value = serde_json::from_str(&request_body).expect("request body should be valid JSON");

        assert_eq!(posted_batch["user_id"], Value::Null);
        assert_eq!(posted_batch["userId"], Value::String(user_id.to_string()));
        assert_eq!(posted_batch["events"].as_array().map(Vec::len), Some(1));
        assert_eq!(posted_batch["events"][0]["eventId"], Value::String("event-success".to_string()));

        assert_eq!(status.pending_count, 0);
        assert_eq!(status.last_synced_at.as_deref(), Some("2026-04-21T12:00:00Z"));
        assert_eq!(status.last_error, None);

        server_thread.join().expect("mock server should shut down cleanly");
    }

    #[test]
    fn flush_outbox_records_last_error_when_api_rejects_batch() {
        let data_dir = make_test_data_dir("flush-error");
        let user_id = "cinnamon-local-user";
        let event = sample_activity_event(user_id, "event-error");
        queue_event_in_data_dir(&data_dir, user_id, event).expect("queue should succeed");

        let (api_base_url, request_body_rx, server_thread) =
            spawn_mock_sync_server("500 Internal Server Error", "sync failed upstream");

        let status = tauri::async_runtime::block_on(flush_outbox_in_data_dir(&data_dir, &api_base_url, user_id))
            .expect("flush should return status even when the API fails");

        request_body_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("server should receive the failed sync batch payload");

        assert_eq!(status.pending_count, 1);
        assert_eq!(status.last_synced_at, None);
        assert_eq!(status.last_error.as_deref(), Some("sync failed upstream"));

        server_thread.join().expect("mock server should shut down cleanly");
    }

    #[test]
    fn flush_outbox_omits_optional_fields_when_event_values_are_empty() {
        let data_dir = make_test_data_dir("flush-clear");
        let user_id = "cinnamon-local-user";
        let event = sample_cleared_event(user_id, "event-cleared");
        queue_event_in_data_dir(&data_dir, user_id, event).expect("queue should succeed");

        let (api_base_url, request_body_rx, server_thread) = spawn_mock_sync_server(
            "202 Accepted",
            r#"{"batchId":"native-batch-test","acceptedEventIds":["event-cleared"],"duplicateEventIds":[],"receivedAt":"2026-04-21T12:00:00Z"}"#,
        );

        let status = tauri::async_runtime::block_on(flush_outbox_in_data_dir(&data_dir, &api_base_url, user_id))
            .expect("flush should succeed");

        let request_body = request_body_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("server should receive the sync batch payload");
        let posted_batch: Value = serde_json::from_str(&request_body).expect("request body should be valid JSON");
        let event_object = posted_batch["events"][0]
            .as_object()
            .expect("queued event should serialize as a JSON object");

        assert!(!event_object.contains_key("activityId"));
        assert!(!event_object.contains_key("departmentId"));
        assert!(!event_object.contains_key("note"));
        assert_eq!(status.pending_count, 0);

        server_thread.join().expect("mock server should shut down cleanly");
    }

    fn make_test_data_dir(label: &str) -> PathBuf {
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ddre-outbox-test-{label}-{unique_suffix}"));
        fs::create_dir_all(&path).expect("test data directory should be created");
        path
    }

    fn sample_activity_event(user_id: &str, event_id: &str) -> ActivityEventPayload {
        ActivityEventPayload {
            event_id: event_id.to_string(),
            user_id: user_id.to_string(),
            device_id: String::from("cinnamon-local-tray"),
            occurred_at: String::from("2026-04-21T11:00:00Z"),
            recorded_at: String::from("2026-04-21T11:00:00Z"),
            event_type: String::from("activity-selected"),
            activity_id: Some(String::from("activity-design")),
            department_id: Some(String::from("department-business-development")),
            note: None,
            idempotency_key: format!("idempotency-{event_id}"),
            metadata: BTreeMap::from([(String::from("platform"), String::from("cinnamon"))]),
        }
    }

    fn sample_cleared_event(user_id: &str, event_id: &str) -> ActivityEventPayload {
        ActivityEventPayload {
            event_id: event_id.to_string(),
            user_id: user_id.to_string(),
            device_id: String::from("cinnamon-local-tray"),
            occurred_at: String::from("2026-04-21T11:05:00Z"),
            recorded_at: String::from("2026-04-21T11:05:00Z"),
            event_type: String::from("activity-cleared"),
            activity_id: None,
            department_id: None,
            note: None,
            idempotency_key: format!("idempotency-{event_id}"),
            metadata: BTreeMap::from([(String::from("platform"), String::from("cinnamon"))]),
        }
    }

    fn spawn_mock_sync_server(
        status_line: &str,
        response_body: &str,
    ) -> (String, Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock server should bind a local port");
        let address = listener.local_addr().expect("mock server should expose its address");
        let status_line = status_line.to_string();
        let response_body = response_body.to_string();
        let (request_body_tx, request_body_rx) = mpsc::channel();

        let thread = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("mock server should accept one request");
            let request = read_http_request(&mut stream);
            let request_body = request
                .split("\r\n\r\n")
                .nth(1)
                .unwrap_or_default()
                .to_string();
            let _ = request_body_tx.send(request_body);

            let response = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .expect("mock server should write its response");
            stream.flush().expect("mock server should flush its response");
        });

        (format!("http://{address}"), request_body_rx, thread)
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("mock server should set a read timeout");

        let mut buffer = Vec::new();
        let mut expected_body_length: Option<usize> = None;
        let mut headers_end = None;

        loop {
            let mut chunk = [0u8; 1024];
            let bytes_read = stream.read(&mut chunk).expect("mock server should read request data");
            if bytes_read == 0 {
                break;
            }

            buffer.extend_from_slice(&chunk[..bytes_read]);

            if headers_end.is_none() {
                headers_end = buffer
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| index + 4);

                if let Some(end) = headers_end {
                    let headers = String::from_utf8_lossy(&buffer[..end]);
                    expected_body_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .or(Some(0));
                }
            }

            if let (Some(end), Some(body_length)) = (headers_end, expected_body_length) {
                if buffer.len() >= end + body_length {
                    break;
                }
            }
        }

        String::from_utf8(buffer).expect("HTTP request should be valid UTF-8")
    }
}
