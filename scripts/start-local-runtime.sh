#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
declare -a PROCESS_NAMES=()
declare -a PROCESS_PIDS=()

prefix_stream() {
  local label="$1"

  while IFS= read -r line; do
    printf '[%s] %s\n' "$label" "$line"
  done
}

print_help() {
  cat <<'EOF'
Usage: npm run dev:all [-- --dry-run]

Starts the local API, dashboard, and native desktop host together.
Press Ctrl+C to stop all three processes.

Options:
  --dry-run   Print the commands without starting anything.
  --help      Show this help text.
EOF
}

cleanup() {
  local exit_code=${1:-0}

  trap - INT TERM EXIT

  if ((${#PROCESS_PIDS[@]} > 0)); then
    printf '\nStopping local runtime processes...\n'

    for pid in "${PROCESS_PIDS[@]}"; do
      kill -TERM -- "-$pid" 2>/dev/null || true
    done

    for pid in "${PROCESS_PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  exit "$exit_code"
}

start_process() {
  local label="$1"
  local command="$2"

  printf 'Starting %s: %s\n' "$label" "$command"

  setsid bash -lc "cd \"$ROOT_DIR\" && $command" \
    > >(prefix_stream "$label") \
    2> >(prefix_stream "$label" >&2) &

  PROCESS_NAMES+=("$label")
  PROCESS_PIDS+=("$!")
}

main() {
  local dry_run=0

  for argument in "$@"; do
    case "$argument" in
      --dry-run)
        dry_run=1
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

  local api_command="npm run dev:api"
  local dashboard_command="npm run dev:web"
  local desktop_command="npm run dev:desktop"

  if [[ $dry_run -eq 1 ]]; then
    printf 'API: %s\n' "$api_command"
    printf 'Dashboard: %s\n' "$dashboard_command"
    printf 'Desktop: %s\n' "$desktop_command"
    return 0
  fi

  start_process "api" "$api_command"
  start_process "dashboard" "$dashboard_command"
  start_process "desktop" "$desktop_command"

  printf '\nLocal runtime started.\n'
  printf 'API health: http://localhost:4000/health\n'
  printf 'Dashboard: http://localhost:5173\n'
  printf 'Desktop frontend dev server: http://localhost:5174\n'
  printf 'Press Ctrl+C to stop all components.\n\n'

  set +e
  wait -n
  local status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    printf '\nOne of the local runtime processes exited. Shutting down the rest.\n'
  else
    printf '\nOne of the local runtime processes exited with status %s. Shutting down the rest.\n' "$status" >&2
  fi

  cleanup "$status"
}

trap 'cleanup $?' INT TERM EXIT

main "$@"