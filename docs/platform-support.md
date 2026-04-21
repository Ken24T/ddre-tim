# Platform Support

## Current Target

The first supported platform is Linux Cinnamon. The initial UX should be menu-driven from the tray so it does not depend on Linux tray click semantics that vary across environments.

The current implementation slice includes a Cinnamon-first desktop shell with:

- a native Tauri tray host with a Cinnamon-specific generated icon and in-place menu updates
- a menu-driven timed-activity picker that stays authoritative in the tray
- a first-run settings flow backed by the API user-settings endpoint
- local SQLite queueing and retry against the current sync-batch endpoint
- guarded Cinnamon autostart management for packaged builds
- native desktop-session detection so GNOME validation does not masquerade as Cinnamon in tray status copy or queued event device IDs

## Platform Model

The desktop app should stay as one product with shared timing, sync, queueing, and settings behavior across platforms.

Platform differences should be handled as entry-surface capabilities rather than separate application forks.

Current direction:

- use a tray-first flow where the platform exposes a reliable tray menu
- keep the tray menu authoritative for fast activity switching
- provide a compact fallback entry surface when tray behavior is inconsistent
- avoid depending on click-only tray semantics as the core interaction model

## Planned Targets

- GNOME: planned after the Cinnamon MVP, with explicit testing on X11 and Wayland.
- Windows 11: planned after the Cinnamon MVP, including packaging, autostart, and tray smoke tests.

The GNOME compatibility spike checklist lives in `docs/gnome-tray-validation.md`.

## Future Considerations

- KDE Plasma is not a committed target yet, but should remain in mind as a future compatibility validation slice.
- KDE should be assessed through the same capability-first model rather than through a separate application design.

## Constraints

- GNOME tray support is inconsistent and may require a fallback launcher or compact window path.
- Linux tray events are not portable enough to be the core interaction model.
- Desktop local persistence should remain per-user regardless of platform.
- Tauri on Linux requires WebKit and libsoup development headers at build time.
- Tray icon assets should remain platform-specific: Cinnamon first, then GNOME and Windows notification-area variants.