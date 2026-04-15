# ADR 0001: Desktop Stack

## Status

Accepted

## Decision

Use Tauri v2 for the tray application, with Rust on the desktop shell side and TypeScript for UI logic.

## Rationale

- The product is tray-first and should stay lightweight.
- Cinnamon is a better fit for a Tauri tray MVP than a heavier Electron shell.
- Rust gives a good boundary for local persistence, background work, and platform integration.

## Consequences

- The first desktop slice should stay menu-driven.
- GNOME support must be validated explicitly rather than assumed.