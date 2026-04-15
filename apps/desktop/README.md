# Desktop App

This directory will host the Cinnamon-first Tauri tray application.

The app is intended to auto-start when the user logs into the OS session so activity capture is available without manual launch.

The first desktop slice should provide:

- A tray icon with a menu-driven activity picker.
- A settings menu for one-time Propercase name entry and CRUD management of the user's timed activity list.
- A system-managed `Not Timed` activity that is always available from the tray menu.
- Recent activities and a stop or idle action.
- Sync status visibility.
- A compact selector window for longer lists or notes.