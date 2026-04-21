# Desktop App

This workspace now contains the first Cinnamon-first desktop shell for TiM.

Current slice:

- a Vite + React desktop shell with a native Tauri host
- a Cinnamon tray icon preview plus queued GNOME and Windows icon variants
- a mutable native tray menu that mirrors the configured activity list
- a menu-driven activity picker backed by `GET /v1/users/:userId/settings`
- first-run settings backed by `PUT /v1/users/:userId/settings`
- desktop settings currently manage the user profile and default department, while shared tray activities stay admin-managed from the dashboard repository
- sync and note events queued through a local SQLite outbox before `POST /v1/sync-batches`
- Cinnamon autostart management for packaged builds
- a quick-selector panel for longer activity lists and notes

Still planned next:

- GNOME and Windows tray-host compatibility work
- packaging and install flow for the native desktop host