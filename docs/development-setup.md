# Development Setup

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- Rust stable toolchain
- Docker Desktop or Docker Engine for local PostgreSQL later

## First Run

1. Run `npm install` at the repo root.
2. Start the API with `npm run dev:api`.
3. Open `http://localhost:4000/health` to confirm the service is running.

By default the current API still uses in-memory storage for user settings if no database connection string is configured.

## API Persistence

The current persistence slice adds PostgreSQL-backed storage for user settings.

To run the API against PostgreSQL instead of the in-memory fallback:

1. Make sure the SQL files in `infra/sql/` have been applied to the target database.
2. Start the API with `DATABASE_URL=<postgres-connection-string> npm run dev:api`.

Current behavior:

- without `DATABASE_URL`, user settings stay in memory for local iteration
- with `DATABASE_URL`, user settings are stored in PostgreSQL using the `user_settings_snapshots` table

## Historical Test Data

To regenerate the current historical seed data from the workbook:

1. Run `npm run import:tim-records -- "/home/ken/Downloads/TiM Metrics.xlsx"`.
2. Use the generated file at `infra/seeds/ken-boyle-historical-tim-records.json` for future database, reporting, or fixture work.

The importer currently:

- parses workbook dates using Australian day-first conventions
- imports only rows belonging to Ken Boyle
- preserves department per row so cross-department work remains intact

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

- Add the Tauri desktop workspace.
- Add a Vite-based web workspace.
- Add database migrations and API persistence.