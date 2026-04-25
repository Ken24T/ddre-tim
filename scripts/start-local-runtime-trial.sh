#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_BINARY="$ROOT_DIR/apps/desktop/src-tauri/target/release/ddre-desktop"
DESKTOP_ENV_PREFIX="env -u GTK_PATH -u GTK_EXE_PREFIX -u GIO_MODULE_DIR -u LOCPATH -u GDK_PIXBUF_MODULEDIR -u GDK_PIXBUF_MODULE_FILE -u GI_TYPELIB_PATH -u GTK_IM_MODULE_FILE"
declare -a PROCESS_PIDS=()

prefix_stream() {
  local label="$1"

  while IFS= read -r line; do
    printf '[%s] %s\n' "$label" "$line"
  done
}

print_help() {
  cat <<'EOF'
Usage: npm run trial:local [-- --skip-build|--dry-run]

Builds the local runtime artifacts, then starts:
- API from compiled dist output
- dashboard from vite preview
- desktop from the native release binary

Options:
  --skip-build  Reuse existing build artifacts.
  --dry-run     Print the commands without starting anything.
  --help        Show this help text.
EOF
}

cleanup() {
  local exit_code=${1:-0}

  trap - INT TERM EXIT

  if ((${#PROCESS_PIDS[@]} > 0)); then
    printf '\nStopping local trial processes...\n'

    for pid in "${PROCESS_PIDS[@]}"; do
      kill -TERM -- "-$pid" 2>/dev/null || true
    done

    for pid in "${PROCESS_PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  exit "$exit_code"
}

run_step() {
  local label="$1"
  local command="$2"

  printf 'Running %s: %s\n' "$label" "$command"
  bash -lc "cd \"$ROOT_DIR\" && $command"
}

start_process() {
  local label="$1"
  local command="$2"

  printf 'Starting %s: %s\n' "$label" "$command"

  setsid bash -lc "cd \"$ROOT_DIR\" && exec $command" \
    > >(prefix_stream "$label") \
    2> >(prefix_stream "$label" >&2) &

  PROCESS_PIDS+=("$!")
}

main() {
  local dry_run=0
  local skip_build=0

  for argument in "$@"; do
    case "$argument" in
      --dry-run)
        dry_run=1
        ;;
      --skip-build)
        skip_build=1
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

  if ! command -v setsid >/dev/null 2>&1; then
    printf 'Missing required command: setsid\n' >&2
    return 1
  fi

  local build_workspace_command="npm run build"
  local build_desktop_command="$DESKTOP_ENV_PREFIX cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml"
  local api_command="npm run start --workspace @ddre/api"
  local dashboard_command="npm run preview --workspace @ddre/web -- --host 127.0.0.1 --port 4173 --strictPort"
  local desktop_command="$DESKTOP_ENV_PREFIX \"$DESKTOP_BINARY\""

  if [[ $dry_run -eq 1 ]]; then
    if [[ $skip_build -eq 0 ]]; then
      printf 'Build workspace: %s\n' "$build_workspace_command"
      printf 'Build desktop binary: %s\n' "$build_desktop_command"
    else
      printf 'Skipping build steps.\n'
    fi

    printf 'API: %s\n' "$api_command"
    printf 'Dashboard: %s\n' "$dashboard_command"
    printf 'Desktop: %s\n' "$desktop_command"
    return 0
  fi

  if [[ $skip_build -eq 0 ]]; then
    run_step "workspace build" "$build_workspace_command"
    run_step "desktop release build" "$build_desktop_command"
  fi

  if [[ ! -x "$DESKTOP_BINARY" ]]; then
    printf 'Desktop binary not found or not executable: %s\n' "$DESKTOP_BINARY" >&2
    return 1
  fi

  start_process "api" "$api_command"
  start_process "dashboard" "$dashboard_command"
  start_process "desktop" "$desktop_command"

  printf '\nLocal runtime trial started.\n'
  printf 'API health: http://127.0.0.1:4000/health\n'
  printf 'Dashboard preview: http://127.0.0.1:4173\n'
  printf 'Desktop frontend is embedded in the native release binary.\n'
  printf 'Press Ctrl+C to stop all components.\n\n'

  set +e
  wait -n
  local status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    printf '\nOne of the local trial processes exited. Shutting down the rest.\n'
  else
    printf '\nOne of the local trial processes exited with status %s. Shutting down the rest.\n' "$status" >&2
  fi

  cleanup "$status"
}

trap 'cleanup $?' INT TERM EXIT

main "$@"