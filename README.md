# ddre-tim

Time in Motion is a multi-user activity capture system built around a lightweight tray application and a central web-facing backend. The first delivery target is a Linux Cinnamon tray workflow, with GNOME and Windows 11 planned as later compatibility slices.

## What Exists Now

- Monorepo root tooling for TypeScript workspaces.
- Shared domain contracts for activities, user settings, and sync batches.
- A minimal Fastify API with health, activity catalog, user settings, and sync-batch endpoints.
- A repeatable workbook import script that generates Ken Boyle-only historical seed data for future persistence and reporting work.
- Core architecture and workflow docs to keep implementation decisions explicit.

## Planned Components

- `apps/desktop`: Cinnamon-first tray application built with Tauri.
- `apps/api`: Central ingest and read-model API.
- `apps/web`: Web viewer for live activity and reporting.
- `packages/contracts`: Shared schemas and types used across the system.
- `docs`: Architecture, ADRs, workflow, and platform notes.

## Quick Start

1. Install Node.js 22+ and Rust stable.
2. Run `npm install` from the repo root.
3. Run `npm run dev:api` to start the initial API.
4. Optional: run `npm run import:tim-records -- "/home/ken/Downloads/TiM Metrics.xlsx"` to regenerate the historical Ken Boyle seed data.

See `docs/development-setup.md` for more detail.
