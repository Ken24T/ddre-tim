# Platform Support

## Current Target

The first supported platform is Linux Cinnamon. The initial UX should be menu-driven from the tray so it does not depend on Linux tray click semantics that vary across environments.

## Planned Targets

- GNOME: planned after the Cinnamon MVP, with explicit testing on X11 and Wayland.
- Windows 11: planned after the Cinnamon MVP, including packaging, autostart, and tray smoke tests.

## Constraints

- GNOME tray support is inconsistent and may require a fallback launcher or compact window path.
- Linux tray events are not portable enough to be the core interaction model.
- Desktop local persistence should remain per-user regardless of platform.