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

## Current Local Services

- API: `http://localhost:4000`
- PostgreSQL: planned through `infra/docker-compose.yml`

## Next Setup Slices

- Add the Tauri desktop workspace.
- Add a Vite-based web workspace.
- Add database migrations and API persistence.