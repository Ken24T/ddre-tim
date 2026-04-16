mod autostart;
mod commands;
mod outbox;
mod tray;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::flush_outbox,
            commands::get_autostart_state,
            commands::show_main_window,
            commands::hide_main_window,
            commands::get_desktop_context,
            commands::get_outbox_status,
            commands::queue_activity_event,
            commands::set_autostart_enabled,
            commands::sync_tray_state
        ])
        .setup(|app| {
            if app.get_webview_window("main").is_none() {
                WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .title("DDRE TiM Desktop")
                    .visible(false)
                    .build()?;
            }

            let autostart_enabled = autostart::get_autostart_state(app.handle())?.enabled;
            let tray_state = tray::build_tray(app.handle(), autostart_enabled)?;
            app.manage(tray_state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DDRE TiM desktop host");
}
