use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContext {
    platform: String,
    tray_channel: &'static str,
}

#[tauri::command]
pub fn get_desktop_context() -> DesktopContext {
    DesktopContext {
        platform: detect_desktop_platform(),
        tray_channel: crate::tray::TRAY_EVENT_CHANNEL,
    }
}

fn detect_desktop_platform() -> String {
    if cfg!(target_os = "windows") {
        return String::from("windows");
    }

    for key in ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION"] {
        if let Ok(value) = std::env::var(key) {
            let normalized = value.to_ascii_lowercase();

            if normalized.contains("cinnamon") {
                return String::from("cinnamon");
            }

            if normalized.contains("gnome") {
                return String::from("gnome");
            }
        }
    }

    String::from("cinnamon")
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| String::from("Main window was not available"))?;

    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| String::from("Main window was not available"))?;

    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sync_tray_state(
    app: AppHandle,
    tray_state: State<'_, crate::tray::DesktopTrayState>,
    payload: crate::tray::TraySyncPayload,
) -> Result<(), String> {
    crate::tray::sync_tray_state(&app, &*tray_state, payload)
}

#[tauri::command]
pub fn queue_activity_event(
    app: AppHandle,
    user_id: String,
    event: crate::outbox::ActivityEventPayload,
) -> Result<crate::outbox::OutboxStatus, String> {
    crate::outbox::queue_event(&app, &user_id, event)
}

#[tauri::command]
pub async fn flush_outbox(
    app: AppHandle,
    api_base_url: String,
    user_id: String,
) -> Result<crate::outbox::OutboxStatus, String> {
    crate::outbox::flush_outbox(&app, &api_base_url, &user_id).await
}

#[tauri::command]
pub fn get_outbox_status(
    app: AppHandle,
    user_id: String,
) -> Result<crate::outbox::OutboxStatus, String> {
    crate::outbox::get_status(&app, &user_id)
}

#[tauri::command]
pub fn get_autostart_state(app: AppHandle) -> Result<crate::autostart::AutostartState, String> {
    crate::autostart::get_autostart_state(&app)
}

#[tauri::command]
pub fn set_autostart_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<crate::autostart::AutostartState, String> {
    crate::autostart::set_autostart_enabled(&app, enabled)
}
