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

## Current Local Services

- API: `http://localhost:4000`
- PostgreSQL: planned through `infra/docker-compose.yml`

## Next Setup Slices

- Add the Tauri desktop workspace.
- Add a Vite-based web workspace.
- Add database migrations and API persistence.