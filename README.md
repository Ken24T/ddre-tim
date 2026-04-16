# ddre-tim

Time in Motion is a multi-user activity capture system built around a lightweight tray application and a central web-facing backend. The first delivery target is a Linux Cinnamon tray workflow, with GNOME and Windows 11 planned as later compatibility slices.

The current runtime target is a zero-cost office-hosted deployment: the shared API, PostgreSQL database, and future dashboard will run on office hardware (`DDNUC-11`), with desktop clients syncing to that central API.

## What Exists Now

- Monorepo root tooling for TypeScript workspaces.
- Shared domain contracts for activities, user settings, and sync batches.
- A minimal Fastify API with health, activity catalog, user settings, and sync-batch endpoints.
- User settings can now persist in PostgreSQL when `DATABASE_URL` is configured, while local development can still fall back to in-memory storage.
- A minimal Vite + React web workspace for local dashboard testing.
- A repeatable workbook import script that uses Ken Boyle workbook rows as the source slice, then expands the dev seed into a multi-user historical dataset for dashboard testing.
- An initial PostgreSQL schema plus generated SQL seed files for local development and future persistence work.
- Core architecture and workflow docs to keep implementation decisions explicit.

## Planned Components

- `apps/desktop`: Cinnamon-first tray application built with Tauri.
- `apps/api`: Central ingest and read-model API.
- `apps/web`: Vite-based web viewer workspace for dashboard development and local testing.
- `packages/contracts`: Shared schemas and types used across the system.
- `docs`: Architecture, ADRs, workflow, and platform notes.

## Quick Start

1. Install Node.js 22+ and Rust stable.
2. Run `npm install` from the repo root.
3. Run `npm run dev:api` to start the initial API.
4. Optional: run `npm run import:tim-records -- "/home/ken/Downloads/TiM Metrics.xlsx"` to regenerate the multi-user historical dashboard seed.
5. Optional: run `npm run db:generate-seed && npm run db:validate` to refresh and validate the local SQL seed artifacts.
6. Optional: run `npm run dev:web` to start the local API-backed dashboard prototype.

See `docs/development-setup.md` for more detail.
