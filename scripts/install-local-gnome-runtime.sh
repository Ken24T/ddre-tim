#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_user_xdg_dir() {
  local value="$1"
  local fallback="$2"

  if [[ -z "$value" || "$value" == "$HOME/snap/"* ]]; then
    printf '%s\n' "$fallback"
  else
    printf '%s\n' "$value"
  fi
}

DATA_HOME="$(resolve_user_xdg_dir "${XDG_DATA_HOME:-}" "$HOME/.local/share")"
CONFIG_HOME="$(resolve_user_xdg_dir "${XDG_CONFIG_HOME:-}" "$HOME/.config")"
INSTALL_DIR="$DATA_HOME/ddre-tim"
BIN_DIR="$INSTALL_DIR/bin"
APPLICATIONS_DIR="$DATA_HOME/applications"
SYSTEMD_USER_DIR="$CONFIG_HOME/systemd/user"
ENV_DIR="$CONFIG_HOME/ddre-tim"
ENV_FILE="$ENV_DIR/runtime.env"
DESKTOP_SOURCE="$ROOT_DIR/apps/desktop/src-tauri/target/release/ddre-desktop"
DESKTOP_TARGET="$BIN_DIR/ddre-desktop"
DESKTOP_ENTRY="$APPLICATIONS_DIR/ddre-tim.desktop"
AUTOSTART_ENTRY="$CONFIG_HOME/autostart/ddre-tim.desktop"
API_WRAPPER="$BIN_DIR/ddre-tim-api"
DASHBOARD_WRAPPER="$BIN_DIR/ddre-tim-dashboard"
API_SERVICE="$SYSTEMD_USER_DIR/ddre-tim-api.service"
DASHBOARD_SERVICE="$SYSTEMD_USER_DIR/ddre-tim-dashboard.service"

dry_run=0
skip_build=0
start_services=0
enable_services=0
install_autostart=0

print_help() {
  cat <<'EOF'
Usage: scripts/install-local-gnome-runtime.sh [options]

Builds and installs a user-local GNOME runtime scaffold for this checkout:
- copies the release desktop binary to ~/.local/share/ddre-tim/bin/
- writes a desktop launcher for the native app
- writes user-level systemd units for the API and dashboard preview
- writes ~/.config/ddre-tim/runtime.env with local defaults if missing

Options:
  --dry-run            Print actions without writing files.
  --skip-build         Reuse existing build artifacts.
  --start              Start the API and dashboard user services after install.
  --enable             Enable the API and dashboard user services at login.
  --install-autostart  Install a desktop autostart entry for the native app.
  --help               Show this help text.

Environment overrides:
  NODE_BIN=/path/to/node
  NPM_BIN=/path/to/npm
EOF
}

log() {
  printf '%s\n' "$*"
}

run() {
  if [[ $dry_run -eq 1 ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi

  "$@"
}

find_executable() {
  local name="$1"
  local override="$2"

  if [[ -n "$override" && -x "$override" ]]; then
    printf '%s\n' "$override"
    return 0
  fi

  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi

  if [[ -x "$HOME/.local/node-v22/bin/$name" ]]; then
    printf '%s\n' "$HOME/.local/node-v22/bin/$name"
    return 0
  fi

  return 1
}

desktop_exec_path() {
  local path="$1"
  local escaped
  escaped="${path//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"

  if [[ "$escaped" == *" "* ]]; then
    printf '"%s"\n' "$escaped"
  else
    printf '%s\n' "$escaped"
  fi
}

write_file() {
  local path="$1"
  local content="$2"

  if [[ $dry_run -eq 1 ]]; then
    printf '[dry-run] write %s\n' "$path"
    return 0
  fi

  mkdir -p "$(dirname "$path")"
  printf '%s' "$content" > "$path"
}

write_executable() {
  local path="$1"
  local content="$2"

  write_file "$path" "$content"
  run chmod 755 "$path"
}

main() {
  for argument in "$@"; do
    case "$argument" in
      --dry-run)
        dry_run=1
        ;;
      --skip-build)
        skip_build=1
        ;;
      --start)
        start_services=1
        ;;
      --enable)
        enable_services=1
        ;;
      --install-autostart)
        install_autostart=1
        ;;
      --help|-h)
        print_help
        return 0
        ;;
      *)
        printf 'Unknown option: %s\n\n' "$argument" >&2
        print_help >&2
        return 1
        ;;
    esac
  done

  local node_bin
  local npm_bin
  node_bin="$(find_executable node "${NODE_BIN:-}")" || {
    printf 'Node.js was not found. Install Node 22+ or set NODE_BIN.\n' >&2
    return 1
  }
  npm_bin="$(find_executable npm "${NPM_BIN:-}")" || {
    printf 'npm was not found. Install npm 10+ or set NPM_BIN.\n' >&2
    return 1
  }

  log "Using node: $node_bin"
  log "Using npm: $npm_bin"

  if [[ $skip_build -eq 0 ]]; then
    run env -u TAURI_DEV -u TAURI_ENV_DEBUG PATH="$(dirname "$node_bin"):$PATH" "$npm_bin" run build
    run env -u TAURI_DEV -u TAURI_ENV_DEBUG -u GTK_PATH -u GTK_EXE_PREFIX -u GIO_MODULE_DIR -u LOCPATH -u GDK_PIXBUF_MODULEDIR -u GDK_PIXBUF_MODULE_FILE -u GI_TYPELIB_PATH -u GTK_IM_MODULE_FILE \
      PATH="$(dirname "$node_bin"):$PATH" "$npm_bin" run tauri:build --workspace @ddre/desktop
  fi

  if [[ $dry_run -eq 0 && ! -x "$DESKTOP_SOURCE" ]]; then
    printf 'Desktop release binary not found: %s\n' "$DESKTOP_SOURCE" >&2
    return 1
  fi

  run mkdir -p "$BIN_DIR" "$APPLICATIONS_DIR" "$SYSTEMD_USER_DIR" "$ENV_DIR"
  run install -m 755 "$DESKTOP_SOURCE" "$DESKTOP_TARGET"

  if [[ ! -f "$ENV_FILE" || $dry_run -eq 1 ]]; then
    write_file "$ENV_FILE" "HOST=127.0.0.1
PORT=4000
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=4173
# Set DATABASE_URL when the runtime is ready to use PostgreSQL instead of infra/local-state/.
# DATABASE_URL=postgres://tim:tim@127.0.0.1:5432/tim
"
  else
    log "Keeping existing environment file: $ENV_FILE"
  fi

  write_executable "$API_WRAPPER" "#!/usr/bin/env bash
set -Eeuo pipefail
cd \"$ROOT_DIR/apps/api\"
exec \"$node_bin\" dist/index.js
"

  write_executable "$DASHBOARD_WRAPPER" "#!/usr/bin/env bash
set -Eeuo pipefail
cd \"$ROOT_DIR\"
export PATH=\"$(dirname "$node_bin"):\$PATH\"
exec \"$npm_bin\" run preview --workspace @ddre/web -- --host \"\${DASHBOARD_HOST:-127.0.0.1}\" --port \"\${DASHBOARD_PORT:-4173}\" --strictPort
"

  write_file "$API_SERVICE" "[Unit]
Description=DDRE TiM API
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
WorkingDirectory=$ROOT_DIR/apps/api
ExecStart=$API_WRAPPER
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
"

  write_file "$DASHBOARD_SERVICE" "[Unit]
Description=DDRE TiM Dashboard Preview
After=ddre-tim-api.service
Wants=ddre-tim-api.service

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
WorkingDirectory=$ROOT_DIR
ExecStart=$DASHBOARD_WRAPPER
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
"

  local desktop_exec
  desktop_exec="$(desktop_exec_path "$DESKTOP_TARGET")"
  write_file "$DESKTOP_ENTRY" "[Desktop Entry]
Type=Application
Version=1.0
Name=DDRE TiM Desktop
Comment=Time in Motion desktop tray capture
Exec=env -u LD_LIBRARY_PATH -u SNAP_LIBRARY_PATH -u GTK_PATH -u GTK_EXE_PREFIX -u GIO_MODULE_DIR -u GSETTINGS_SCHEMA_DIR -u LOCPATH -u GDK_PIXBUF_MODULEDIR -u GDK_PIXBUF_MODULE_FILE -u GI_TYPELIB_PATH -u GTK_IM_MODULE_FILE WEBKIT_DISABLE_DMABUF_RENDERER=1 $desktop_exec
TryExec=$desktop_exec
Terminal=false
StartupNotify=false
Categories=Office;
OnlyShowIn=GNOME;X-Cinnamon;
"

  if [[ $install_autostart -eq 1 ]]; then
    write_file "$AUTOSTART_ENTRY" "$(cat "$DESKTOP_ENTRY" 2>/dev/null || printf '[Desktop Entry]\n')"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run systemctl --user daemon-reload

    if [[ $enable_services -eq 1 ]]; then
      run systemctl --user enable ddre-tim-api.service ddre-tim-dashboard.service
    fi

    if [[ $start_services -eq 1 ]]; then
      run systemctl --user restart ddre-tim-api.service ddre-tim-dashboard.service
    fi
  else
    log "systemctl not found; user services were written but not loaded."
  fi

  log "Installed DDRE TiM local runtime scaffold."
  log "Desktop launcher: $DESKTOP_ENTRY"
  log "Runtime env: $ENV_FILE"
  log "API service: $API_SERVICE"
  log "Dashboard service: $DASHBOARD_SERVICE"
}

main "$@"
