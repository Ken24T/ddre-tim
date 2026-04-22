# Development Setup

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Rust stable toolchain
- Linux desktop headers for Tauri on Cinnamon: `libgtk-3-dev`, `libsoup-3.0-dev`, and `libwebkit2gtk-4.1-dev`
- Docker Desktop or Docker Engine for local PostgreSQL later

## First Run

1. Run `npm install` at the repo root.
2. Run `npm run dev:all` if you want to launch the API, dashboard, and native desktop together for a local runtime trial.
3. Or start the API alone with `npm run dev:api`.
4. Optional: start the Cinnamon-first desktop workspace with `npm run dev:desktop`.
5. Optional: start the web workspace with `npm run dev:web` if you want the local dashboard prototype.
6. Open `http://localhost:4000/health` to confirm the API is running.
7. Open `http://localhost:5174` to confirm the desktop frontend dev server is running when the Tauri host starts.
8. Open `http://localhost:5173` to confirm the Vite dashboard is running.

By default the current API now uses local file-backed storage under `infra/local-state/` when no database connection string is configured.

The desktop workspace now has two local execution modes:

- `npm run dev:desktop` starts the native Tauri host and the desktop frontend together.
- `npm run dev:web --workspace @ddre/desktop` builds or previews the browser fallback shell without launching the native host.

For a single-command local trial across the main runtime surfaces:

- `npm run dev:all` starts the API, the dashboard, and the native desktop host together and stops them as a group when you press `Ctrl+C`.
- `npm run trial:local` builds the current repo, builds the native desktop release binary, then runs the built API, the dashboard preview server, and the desktop release binary together. Use `npm run trial:local -- --skip-build` for repeat launches when you already have fresh build artifacts.

If you launch the repo from the VS Code Snap on Ubuntu, the desktop workspace scripts now clear Snap-injected GTK/GIO environment variables before starting Tauri so the native host uses the system desktop libraries instead of the Snap runtime.

On Linux Wayland sessions, the native desktop host also forces `WEBKIT_DISABLE_DMABUF_RENDERER=1` at process startup to avoid blank or crashed WebKitGTK settings windows seen during GNOME compatibility validation.

Verification is also split deliberately:

- `npm run typecheck` validates the shared contracts, API, desktop React shell, and web TypeScript without requiring the native Tauri Linux headers.
- `npm run build` validates the shared packages, API, desktop web shell, and web dashboard without requiring the native Tauri Linux headers.
- `npm run build:native --workspace @ddre/desktop` and `npm run tauri:check --workspace @ddre/desktop` still validate the native desktop host and require the WebKit/libsoup development packages listed above.

Current Cinnamon-native behavior:

- the tray menu is owned by Tauri and updated in place from the React shell
- activity and note events are queued in a per-user local SQLite outbox before being flushed to `POST /v1/sync-batches`
- the desktop settings surface now saves user-specific personal timed activities that sit alongside the shared dashboard-managed activity catalog
- the desktop shell keeps a local recent-activities list per user key so tray activity selections survive desktop restarts during local iteration
- autostart management exists for Cinnamon and GNOME sessions, but stays disabled in development builds so login does not point at a local debug binary

## API Persistence

The current persistence slice now has two modes:

- local file-backed persistence in `infra/local-state/` when `DATABASE_URL` is not configured
- PostgreSQL-backed storage for user settings and the shared activity repository when `DATABASE_URL` is configured

To run the API against PostgreSQL instead of the local file-backed fallback:

1. Make sure the SQL files in `infra/sql/` have been applied to the target database.
2. Start the API with `DATABASE_URL=<postgres-connection-string> npm run dev:api`.

Current behavior:

- without `DATABASE_URL`, user settings, the shared activity repository, and accepted sync events are stored in JSON files under `infra/local-state/`
- with `DATABASE_URL`, user settings are stored in PostgreSQL using the `user_settings_snapshots` table and the shared activity repository is stored in PostgreSQL using `activity_repository_entries`
- the dashboard read model now treats `infra/seeds/ken-boyle-historical-tim-records.json` as the historical base and layers in live timed sessions derived from the synced tray event log

## Historical Test Data

To regenerate the current historical seed data from the workbook:

1. Run `npm run import:tim-records -- "/home/ken/Downloads/TiM Metrics.xlsx"`.
2. Use the generated file at `infra/seeds/ken-boyle-historical-tim-records.json` for future database, reporting, or fixture work.

The importer currently:

- parses workbook dates using Australian day-first conventions
- uses Ken Boyle workbook rows as the imported source slice
- expands that source slice into additional deterministic synthetic users for multi-user dashboard testing
- preserves department per row so cross-department work remains intact
- combines repeated `Date + Employee + Department + Activity` rows into a single record by summing `Hours`

## Local Database Artifacts

The repo now includes:

- `infra/sql/001_initial_schema.sql` for the initial PostgreSQL schema
- `infra/sql/002_user_settings_snapshots.sql` for the current API settings-persistence table
- `infra/sql/010_seed_ken_boyle_historical.sql` for the generated historical seed load

Useful commands:

- `npm run db:generate-seed` regenerates the SQL seed file from `infra/seeds/ken-boyle-historical-tim-records.json`
- `npm run db:validate` loads the schema and seed into an in-memory PostgreSQL emulator and verifies counts and mappings

If Docker is available later, `infra/docker-compose.yml` mounts `infra/sql` into Postgres init so a fresh local volume can bootstrap the schema and seed automatically.

## Current Local Services

- API: `http://localhost:4000`
- Desktop frontend dev server: `http://localhost:5174`
- Web dashboard prototype: `http://localhost:5173`
- PostgreSQL: scaffolded through `infra/docker-compose.yml`

## Runtime Planning Target

The current target deployment is an office-hosted setup on `DDNUC-11` rather than a paid hosted platform.

Expected production shape:

- `DDNUC-11` runs the central API and PostgreSQL datastore
- the future dashboard is served from the same office-hosted machine unless later split out
- office staff use the dashboard from machines on the office LAN
- employees working from home connect only to the API through a secure path into the office network

Operational assumptions for this target:

- do not expose PostgreSQL directly outside the host machine
- prefer exposing only the API surface needed by desktop clients
- keep dashboard access restricted to the office LAN unless a later slice intentionally expands that scope
- deployment remains a planned/manual slice until the repo defines the exact service supervisor, backup process, rollback procedure, and remote-access approach

## Next Setup Slices

- Move the local file-backed sync-event log into normalized database-backed activity-event tables.
- Expand the web workspace from a local shell into real dashboard read models and views.
- Add GNOME and Windows native tray-host compatibility work on top of the shared desktop shell.