# Architecture

## System Shape

The system is split into three products:

- A desktop tray client for capturing user activity.
- A central API that validates, stores, and projects activity data.
- A web viewer that reads derived session and reporting data.

## Runtime Target

The current runtime target is a zero-cost office-hosted deployment on `DDNUC-11`.

Planned hosting layout:

- the API runs on `DDNUC-11`
- PostgreSQL runs on `DDNUC-11`
- the future TiM dashboard is served from `DDNUC-11`
- office desktops reach the API and dashboard over the office LAN
- home-based employees reach only the API through a secure remote path into the office network

Constraints for this model:

- PostgreSQL is not exposed directly to employee workstations or the public internet
- the dashboard is intended for office-LAN viewing only, not general external access
- remote employees still need a secure office-network path, such as VPN or equivalent tunnel, so the desktop client can sync to the API

## Startup

The desktop tray client is expected to auto-start inside each user's session when they log into their workstation. On first run it should route the user into settings before normal tray-driven capture begins.

## Write Path

Desktop clients do not write directly to a shared database or filesystem. They send activity events to the API, which owns validation, idempotency, persistence, and reporting projections.

## Event Model

The client records append-only activity change events. Sessions and durations are derived centrally from event history. This keeps the desktop client simple and makes corrections, auditing, and replay possible.

Selecting a new timed activity ends the previous timed activity and starts the newly selected one at the interaction timestamp. The system-managed `Not Timed` activity is always available as a default non-timed state so users can explicitly move out of timed work without deleting history.

## Offline Behavior

The desktop client will keep a local SQLite outbox per user and sync batches to the API when connectivity returns.

## User Settings

Each user will have a settings surface for one-time profile setup and maintenance of the activity list shown in the tray menu. The API owns the stored user name and normalized activity definitions so activity events can reference stable identifiers.

Display names are normalized to Propercase. Each user also has a default department used when creating new timed activities, while individual timed activities can be reassigned to a different department when needed. The non-timed default activity is system-managed so users can CRUD their department-appropriate timed activities without removing the default fallback state.

## Dashboard Access

The browser dashboard is manager-facing and must enforce server-side scope filtering. A property manager should only see the staff assigned to their property-management scope, while broader roles such as business owner can be granted access to all departments and users.

The current deployment assumption is that dashboard access happens from machines on the office LAN. Remote desktop users may sync activity through the API, but the dashboard is not currently planned as a general internet-facing application.

## Database Shape

The primary database should store normalized users, departments, activities, and append-only activity events. Reporting totals such as daily hours, weekly totals, month labels, and chart aggregates should be derived from those facts rather than authored directly.

The reviewed legacy workbook shape is useful as an import and reporting reference, but not as the source-of-truth live schema. For the current historical backfill slice, import only Ken Boyle records and normalize workbook dates using Australian day-first conventions before deriving reporting periods. See `docs/database-schema.md` for the proposed table layout and the rationale for excluding derived fields such as `Week` and `Month` from primary tables.

## Initial Implementation Slice

This repository currently contains:

- Shared contracts for activities and sync batches.
- A starter API with a seeded activity catalog, user settings endpoints, and a sync endpoint.
- A minimal Vite-based web shell for local dashboard testing.
- Repo docs and structure for the desktop and web slices that follow.