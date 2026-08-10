use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const API_SERVICE_UNIT: &str = "ddre-tim-api.service";
const DASHBOARD_SERVICE_UNIT: &str = "ddre-tim-dashboard.service";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartState {
    pub enabled: bool,
    pub available: bool,
    pub detail: String,
}

struct LoginRuntimeServices {
}

pub fn get_autostart_state(app: &AppHandle) -> Result<AutostartState, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let path = autostart_file_path(app)?;

    if !desktop_autostart_available(&executable) {
        return Ok(AutostartState {
            enabled: false,
            available: false,
            detail: String::from(
                "Autostart stays disabled in development builds so login does not point at a non-packaged binary.",
            ),
        });
    }

    let Some(services) = login_runtime_services(app)? else {
        return Ok(AutostartState {
            enabled: false,
            available: false,
            detail: String::from(
                "Launch at sign-in requires the installed local runtime services for the API and dashboard.",
            ),
        });
    };

    let enabled = path.exists() && services.enabled()?;
    let detail = if enabled {
        format!(
            "Launch at sign-in is enabled from {}. {} and {} are enabled for the next sign-in.",
            path.display(),
            API_SERVICE_UNIT,
            DASHBOARD_SERVICE_UNIT
        )
    } else {
        format!(
            "Launch at sign-in will write {} and enable {} plus {} for the next sign-in.",
            path.display(),
            API_SERVICE_UNIT,
            DASHBOARD_SERVICE_UNIT
        )
    };

    Ok(AutostartState {
        enabled,
        available: true,
        detail,
    })
}

pub fn set_autostart_enabled(app: &AppHandle, enabled: bool) -> Result<AutostartState, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;

    if !desktop_autostart_available(&executable) {
        return get_autostart_state(app);
    }

    let Some(services) = login_runtime_services(app)? else {
        return get_autostart_state(app);
    };

    let file_path = autostart_file_path(app)?;

    if enabled {
        let desktop_entry = render_desktop_entry(&executable);
        fs::write(&file_path, desktop_entry).map_err(|error| error.to_string())?;
        services.set_enabled(true)?;
    } else if file_path.exists() {
        fs::remove_file(&file_path).map_err(|error| error.to_string())?;
        services.set_enabled(false)?;
    } else {
        services.set_enabled(false)?;
    }

    get_autostart_state(app)
}

fn desktop_autostart_available(executable: &Path) -> bool {
    !cfg!(debug_assertions) && !executable.to_string_lossy().contains("/target/")
}

impl LoginRuntimeServices {
    fn enabled(&self) -> Result<bool, String> {
        Ok(is_systemd_unit_enabled(API_SERVICE_UNIT)?
            && is_systemd_unit_enabled(DASHBOARD_SERVICE_UNIT)?)
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        run_systemctl_user(&["daemon-reload"])?;

        if enabled {
            run_systemctl_user(&["enable", API_SERVICE_UNIT, DASHBOARD_SERVICE_UNIT])
        } else {
            run_systemctl_user(&["disable", API_SERVICE_UNIT, DASHBOARD_SERVICE_UNIT])
        }
    }
}

fn login_runtime_services(app: &AppHandle) -> Result<Option<LoginRuntimeServices>, String> {
    if !command_exists("systemctl") {
        return Ok(None);
    }

    let service_directory = app
        .path()
        .config_dir()
        .map_err(|error| error.to_string())?
        .join("systemd")
        .join("user");
    let api_unit_path = service_directory.join(API_SERVICE_UNIT);
    let dashboard_unit_path = service_directory.join(DASHBOARD_SERVICE_UNIT);

    if !api_unit_path.exists() || !dashboard_unit_path.exists() {
        return Ok(None);
    }

    Ok(Some(LoginRuntimeServices {}))
}

fn is_systemd_unit_enabled(unit: &str) -> Result<bool, String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .arg("is-enabled")
        .arg(unit)
        .output()
        .map_err(|error| format!("Failed to check {unit}: {error}"))?;

    Ok(output.status.success())
}

fn run_systemctl_user(arguments: &[&str]) -> Result<(), String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(arguments)
        .output()
        .map_err(|error| format!("Failed to run systemctl --user {}: {error}", arguments.join(" ")))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let reason = if stderr.is_empty() { stdout } else { stderr };

    Err(format!(
        "systemctl --user {} failed: {}",
        arguments.join(" "),
        reason
    ))
}

fn command_exists(name: &str) -> bool {
    env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).any(|directory| directory.join(name).exists()))
        .unwrap_or(false)
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
