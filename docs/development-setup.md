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
- `infra/sql/010_seed_ken_boyle_historical.sql` for the generated historical seed load

Useful commands:

- `npm run db:generate-seed` regenerates the SQL seed file from `infra/seeds/ken-boyle-historical-tim-records.json`
- `npm run db:validate` loads the schema and seed into an in-memory PostgreSQL emulator and verifies counts and mappings

If Docker is available later, `infra/docker-compose.yml` mounts `infra/sql` into Postgres init so a fresh local volume can bootstrap the schema and seed automatically.

## Current Local Services

- API: `http://localhost:4000`
- PostgreSQL: scaffolded through `infra/docker-compose.yml`

## Next Setup Slices

- Add the Tauri desktop workspace.
- Add a Vite-based web workspace.
- Add database migrations and API persistence.