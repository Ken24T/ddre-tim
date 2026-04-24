mod autostart;
mod commands;
mod outbox;
mod tray;

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub fn run() {
    apply_linux_webview_workarounds();

    tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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
                eprintln!(
                    "ddre-desktop main window source: {}",
                    describe_main_window_source()
                );

                WebviewWindowBuilder::new(app, "main", resolve_main_window_url())
                    .on_navigation(|url| {
                        eprintln!("ddre-desktop main window navigation: {url}");
                        true
                    })
                    .on_page_load(|window, payload| {
                        eprintln!(
                            "ddre-desktop page load for {}: {}",
                            window.label(),
                            payload.url()
                        );
                    })
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

fn resolve_main_window_url() -> WebviewUrl {
    if cfg!(debug_assertions) && is_desktop_dev_server_available() {
        WebviewUrl::default()
    } else {
        WebviewUrl::App("index.html".into())
    }
}

fn describe_main_window_source() -> &'static str {
    if cfg!(debug_assertions) && is_desktop_dev_server_available() {
        "desktop dev server"
    } else {
        "bundled app assets"
    }
}

fn is_desktop_dev_server_available() -> bool {
    let Ok(addresses) = "localhost:5174".to_socket_addrs() else {
        return false;
    };

    addresses.into_iter().any(|address| {
        TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
    })
}

fn apply_linux_webview_workarounds() {
    if !cfg!(target_os = "linux") {
        return;
    }

    let is_wayland = std::env::var("XDG_SESSION_TYPE")
        .map(|value| value.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false);

    if is_wayland && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // Recent WebKitGTK Wayland sessions can paint a blank white window or crash the web process.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}
