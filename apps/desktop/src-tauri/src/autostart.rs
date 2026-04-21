use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartState {
    pub enabled: bool,
    pub available: bool,
    pub detail: String,
}

pub fn get_autostart_state(app: &AppHandle) -> Result<AutostartState, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let available = autostart_available(&executable);
    let path = autostart_file_path(app)?;
    let enabled = available && path.exists();

    let detail = if available {
        if enabled {
            format!("Cinnamon autostart is enabled from {}.", path.display())
        } else {
            format!("Cinnamon autostart will be written to {}.", path.display())
        }
    } else {
        String::from("Autostart stays disabled in development builds so login does not point at a non-packaged binary.")
    };

    Ok(AutostartState {
        enabled,
        available,
        detail,
    })
}

pub fn set_autostart_enabled(app: &AppHandle, enabled: bool) -> Result<AutostartState, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;

    if !autostart_available(&executable) {
        return get_autostart_state(app);
    }

    let file_path = autostart_file_path(app)?;

    if enabled {
        let desktop_entry = render_desktop_entry(&executable);
        fs::write(&file_path, desktop_entry).map_err(|error| error.to_string())?;
    } else if file_path.exists() {
        fs::remove_file(&file_path).map_err(|error| error.to_string())?;
    }

    get_autostart_state(app)
}

fn autostart_available(executable: &Path) -> bool {
    !cfg!(debug_assertions) && !executable.to_string_lossy().contains("/target/")
}

fn autostart_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .config_dir()
        .map_err(|error| error.to_string())?
        .join("autostart");

    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    Ok(directory.join("ddre-tim.desktop"))
}

fn render_desktop_entry(executable: &Path) -> String {
    let exec = quote_desktop_exec_path(executable);

    format!(
        concat!(
            "[Desktop Entry]\n",
            "Type=Application\n",
            "Version=1.0\n",
            "Name=DDRE TiM Desktop\n",
            "Comment=Time in Motion desktop tray capture\n",
            "Exec={exec}\n",
            "TryExec={exec}\n",
            "Terminal=false\n",
            "OnlyShowIn=X-Cinnamon;GNOME;\n",
            "X-GNOME-Autostart-enabled=true\n",
            "Categories=Office;\n"
        ),
        exec = exec
    )
}

fn quote_desktop_exec_path(executable: &Path) -> String {
    let raw = executable
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");

    if raw.contains(' ') {
        format!("\"{}\"", raw)
    } else {
        raw
    }
}
