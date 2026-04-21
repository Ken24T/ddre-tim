use std::{fs, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager, Runtime, Wry,
};

pub const TRAY_EVENT_CHANNEL: &str = "desktop://tray-menu";

const STATUS_ID: &str = "status";
const DETAIL_ID: &str = "detail";
const OPEN_SETTINGS_ID: &str = "open-settings";
const ACTIVITIES_ID: &str = "activities";
const ACTIVITY_ID_PREFIX: &str = "activity::";
const EMPTY_ACTIVITY_ID: &str = "activity::empty";
const TRIGGER_SYNC_ID: &str = "trigger-sync";
const TOGGLE_AUTOSTART_ID: &str = "toggle-autostart";
const QUIT_ID: &str = "quit";

pub struct DesktopTrayState<R: Runtime = Wry> {
    #[allow(dead_code)]
    tray_icon: TrayIcon<R>,
    status_item: MenuItem<R>,
    detail_item: MenuItem<R>,
    settings_item: MenuItem<R>,
    activities_menu: Submenu<R>,
    activity_items: Mutex<Vec<MenuItem<R>>>,
    autostart_item: CheckMenuItem<R>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayActivityPayload {
    pub id: String,
    pub label: String,
    pub helper: String,
    pub active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySyncPayload {
    pub current_activity_label: String,
    pub secondary_label: String,
    pub activities: Vec<TrayActivityPayload>,
    pub configured: bool,
    pub autostart_enabled: bool,
    pub autostart_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrayEventPayload {
    action: String,
    activity_id: Option<String>,
}

pub fn build_tray<R: Runtime>(
    app: &AppHandle<R>,
    autostart_enabled: bool,
) -> tauri::Result<DesktopTrayState<R>> {
    let status_item = MenuItem::with_id(app, STATUS_ID, "Current: Not Timed", false, None::<&str>)?;
    let detail_item = MenuItem::with_id(
        app,
        DETAIL_ID,
        "Waiting for the first tray action",
        false,
        None::<&str>,
    )?;
    let open_settings =
        MenuItem::with_id(app, OPEN_SETTINGS_ID, "Finish setup", true, None::<&str>)?;
    let activities_menu = Submenu::with_id(app, ACTIVITIES_ID, "Timed activities", true)?;
    let placeholder_activity = MenuItem::with_id(
        app,
        EMPTY_ACTIVITY_ID,
        "Finish setup to unlock timed activities",
        false,
        None::<&str>,
    )?;
    activities_menu.append(&placeholder_activity)?;
    let trigger_sync = MenuItem::with_id(app, TRIGGER_SYNC_ID, "Sync Now", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        TOGGLE_AUTOSTART_ID,
        "Launch at sign-in",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    autostart_item.set_enabled(false)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let secondary_separator = PredefinedMenuItem::separator(app)?;
    let tertiary_separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &detail_item,
            &separator,
            &open_settings,
            &activities_menu,
            &secondary_separator,
            &trigger_sync,
            &autostart_item,
            &tertiary_separator,
            &quit,
        ],
    )?;

    let temp_dir = app
        .path()
        .runtime_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("ddre-tim-tray");
    let _ = fs::create_dir_all(&temp_dir);

    let tray_icon = TrayIconBuilder::with_id("tim-tray")
        .icon(build_cinnamon_icon())
        .temp_dir_path(&temp_dir)
        .tooltip("Time in Motion")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            OPEN_SETTINGS_ID => {
                let _ = show_main_window(app);
                let _ = emit_tray_event(app, OPEN_SETTINGS_ID, None);
            }
            TRIGGER_SYNC_ID => {
                let _ = emit_tray_event(app, TRIGGER_SYNC_ID, None);
            }
            TOGGLE_AUTOSTART_ID => {
                let _ = emit_tray_event(app, TOGGLE_AUTOSTART_ID, None);
            }
            QUIT_ID => {
                app.exit(0);
            }
            other if other.starts_with(ACTIVITY_ID_PREFIX) => {
                let activity_id = other.trim_start_matches(ACTIVITY_ID_PREFIX);
                let _ = emit_tray_event(app, "select-activity", Some(activity_id.to_string()));
            }
            _ => {}
        })
        .build(app)?;

    Ok(DesktopTrayState {
        tray_icon,
        status_item,
        detail_item,
        settings_item: open_settings,
        activities_menu,
        activity_items: Mutex::new(vec![placeholder_activity]),
        autostart_item,
    })
}

pub fn sync_tray_state<R: Runtime>(
    app: &AppHandle<R>,
    tray_state: &DesktopTrayState<R>,
    payload: TraySyncPayload,
) -> Result<(), String> {
    tray_state
        .status_item
        .set_text(format!("Current: {}", payload.current_activity_label))
        .map_err(|error: tauri::Error| error.to_string())?;
    tray_state
        .detail_item
        .set_text(payload.secondary_label)
        .map_err(|error: tauri::Error| error.to_string())?;
    tray_state
        .settings_item
        .set_text(if payload.configured {
            "Open Settings"
        } else {
            "Finish setup"
        })
        .map_err(|error: tauri::Error| error.to_string())?;
    tray_state
        .autostart_item
        .set_checked(payload.autostart_enabled)
        .map_err(|error: tauri::Error| error.to_string())?;
    tray_state
        .autostart_item
        .set_enabled(payload.autostart_available)
        .map_err(|error: tauri::Error| error.to_string())?;
    tray_state
        .activities_menu
        .set_enabled(payload.configured)
        .map_err(|error: tauri::Error| error.to_string())?;

    let mut items = tray_state
        .activity_items
        .lock()
        .map_err(|_| String::from("Tray activity menu state was poisoned."))?;

    for item in items.drain(..) {
        tray_state
            .activities_menu
            .remove(&item)
            .map_err(|error: tauri::Error| error.to_string())?;
    }

    if payload.activities.is_empty() {
        let empty_label = if payload.configured {
            "No timed activities are active"
        } else {
            "Finish setup to unlock timed activities"
        };
        let placeholder =
            MenuItem::with_id(app, EMPTY_ACTIVITY_ID, empty_label, false, None::<&str>)
                .map_err(|error: tauri::Error| error.to_string())?;
        tray_state
            .activities_menu
            .append(&placeholder)
            .map_err(|error: tauri::Error| error.to_string())?;
        items.push(placeholder);
        return Ok(());
    }

    for activity in payload.activities {
        let label = if activity.active {
            format!("• {}", activity.label)
        } else if activity.helper.trim().is_empty() {
            activity.label
        } else {
            format!("{} · {}", activity.label, activity.helper)
        };
        let item = MenuItem::with_id(
            app,
            format!("{}{}", ACTIVITY_ID_PREFIX, activity.id),
            label,
            payload.configured,
            None::<&str>,
        )
        .map_err(|error: tauri::Error| error.to_string())?;
        tray_state
            .activities_menu
            .append(&item)
            .map_err(|error: tauri::Error| error.to_string())?;
        items.push(item);
    }

    Ok(())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

    Ok(())
}

fn emit_tray_event<R: Runtime>(
    app: &AppHandle<R>,
    action: &str,
    activity_id: Option<String>,
) -> tauri::Result<()> {
    app.emit(
        TRAY_EVENT_CHANNEL,
        TrayEventPayload {
            action: action.to_string(),
            activity_id,
        },
    )
}

fn build_cinnamon_icon() -> Image<'static> {
    let size = 32u32;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let center = (size as f32 - 1.0) / 2.0;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let distance = (dx * dx + dy * dy).sqrt();

            if distance <= 13.0 {
                set_pixel(&mut rgba, size, x, y, [22, 48, 42, 255]);
            }

            if (12.5..=14.0).contains(&distance) {
                set_pixel(&mut rgba, size, x, y, [138, 216, 200, 255]);
            }
        }
    }

    for offset in -1..=1 {
        draw_line(
            &mut rgba,
            size,
            16 + offset,
            16,
            16 + offset,
            8,
            [226, 245, 240, 255],
        );
        draw_line(
            &mut rgba,
            size,
            16,
            16 + offset,
            23,
            19 + offset,
            [138, 216, 200, 255],
        );
    }

    set_pixel(&mut rgba, size, 16, 16, [255, 255, 255, 255]);
    Image::new_owned(rgba, size, size)
}

fn draw_line(
    rgba: &mut [u8],
    size: u32,
    mut x0: i32,
    mut y0: i32,
    x1: i32,
    y1: i32,
    color: [u8; 4],
) {
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut error = dx + dy;

    loop {
        if x0 >= 0 && y0 >= 0 {
            set_pixel(rgba, size, x0 as u32, y0 as u32, color);
        }

        if x0 == x1 && y0 == y1 {
            break;
        }

        let doubled = error * 2;
        if doubled >= dy {
            error += dy;
            x0 += sx;
        }
        if doubled <= dx {
            error += dx;
            y0 += sy;
        }
    }
}

fn set_pixel(rgba: &mut [u8], size: u32, x: u32, y: u32, color: [u8; 4]) {
    if x >= size || y >= size {
        return;
    }

    let index = ((y * size + x) * 4) as usize;
    rgba[index..index + 4].copy_from_slice(&color);
}
