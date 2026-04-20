# GNOME Tray Validation

## Purpose

This spike exists to validate GNOME as a compatibility target without forking the desktop app into a separate GNOME-specific product.

The goal is to answer one question clearly:

- can GNOME support the Time in Motion capture flow well enough through a tray-first entry point, or does it need a fallback quick-capture window as the primary path?

## Working Rules

- Keep one desktop app and one shared command model.
- Treat the tray as the preferred entry point where it is reliable.
- Do not treat the tray as the only way to record activity.
- Base support decisions on capabilities, not distro names.
- Consider KDE Plasma a future validation target, not part of this spike.

## Validation Matrix

Run the checks below on the combinations that are practical to test:

| Session | Tray Extension State | Expected Outcome |
| --- | --- | --- |
| GNOME Wayland | No extension | Fallback path may be required |
| GNOME Wayland | AppIndicator-compatible extension present | Tray may be usable but must be verified |
| GNOME X11 | No extension | Tray behavior may still be inconsistent |
| GNOME X11 | AppIndicator-compatible extension present | Best-case tray validation path |

Record the actual result for each combination as `pass`, `degraded`, or `fail`.

## Functional Checks

For each environment under test, verify the following:

1. The app launches successfully.
2. The tray icon is visible without requiring undocumented manual steps.
3. The tray menu opens consistently.
4. The current activity label updates after activity selection.
5. Selecting a timed activity queues the correct event.
6. Selecting `Not Timed` clears the active timed state.
7. `Open TiM` shows the main window reliably.
8. `Open Settings` routes the user into the settings flow reliably.
9. `Sync Now` can flush the local outbox through the API.
10. The app remains usable if tray visibility fails.

## Fallback Requirements

If GNOME tray behavior is inconsistent, the fallback path should become the supported GNOME entry surface.

That fallback should:

- open a compact quick-capture window from the desktop launcher
- expose the same activity commands as the tray menu
- support note entry without requiring the full settings window
- show the current activity and sync state clearly
- work whether or not a tray extension is installed

## Capability Model

The desktop app should choose behavior from capabilities rather than hard-coded platform branches.

Suggested capability flags for the desktop host:

- `trayMenuReliable`
- `trayIconVisible`
- `fallbackWindowRequired`
- `autostartSupported`
- `notificationPromptSupported`

The capture engine, local outbox, sync, and activity switching rules should stay shared regardless of those flags.

## Decision Output

At the end of the spike, produce a short recommendation in one of these forms:

- `GNOME supported with tray-first flow`
- `GNOME supported with fallback-first flow`
- `GNOME deferred until tray or fallback gaps are closed`

That recommendation should also state:

- whether support differs between X11 and Wayland
- whether any extension dependency is acceptable or unacceptable
- which missing behaviors require a follow-up implementation slice

## Follow-up Slice Candidates

- `slice/gnome-capability-detection`
- `slice/gnome-fallback-entrypoint`
- `slice/desktop-quick-capture-window`
- `slice/windows-notification-area-validation`