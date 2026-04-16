# Time in Motion – Copilot Instructions

## Project Overview

Time in Motion is a multi-user activity capture system built around a lightweight tray application and a central web-facing backend.

The current delivery plan is:

- Linux Cinnamon first for the desktop tray experience.
- GNOME and Windows 11 as later compatibility slices.
- A central API as the authoritative write path.
- A browser dashboard for manager and business-owner reporting.

This repo is a monorepo. The desktop app, API, web viewer, shared contracts, and docs should evolve together.

## Current Status

- The TCTBP runtime surface is installed for this repository.
- The current release version files are `package.json`, `apps/api/package.json`, and `packages/contracts/package.json`.
- The current verification gates are `npm run typecheck` and `npm run build`.
- The current runtime target is a zero-cost office-hosted deployment on `DDNUC-11` for the API, PostgreSQL, and future dashboard.
- Deploy is still intentionally disabled until the repo defines the concrete service management, backup, rollback, remote-access, and post-deploy validation path for that office-hosted target.

## TCTBP Runtime Surface

The TCTBP runtime and workflow surface lives in:

- `.github/agents/TCTBP.agent.md`
- `.github/TCTBP.json`
- `.github/TCTBP Agent.md`
- `.github/TCTBP Cheatsheet.md`
- `.github/copilot-instructions.md`
- `.github/prompts/Install TCTBP Agent Infrastructure Into Another Repository.prompt.md`
- optional hook layer: `.github/hooks/tctbp-safety.json` and `scripts/tctbp-pretool-hook.js`

Keep these files aligned when the workflow or runtime entry points change.

The consolidated cross-repo application prompt is expected to be discoverable through the explicit local-only trigger `reconcile-tctbp <absolute-target-repo-path>`.

## TCTBP Workflow Expectations

- If the user asks to ship, checkpoint, publish, handover, resume, deploy, status, abort, or branch, follow `.github/TCTBP Agent.md` and `.github/TCTBP.json`.
- Use `checkpoint`, `publish`, and `handover` for routine slice safety and sync; reserve `ship` for milestone-quality releases.
- `slice/*` is the preferred delivery branch prefix and drives the first-ship minor-bump rule.
- Keep the workflow files and runtime files aligned when they change.

## Current Structure

| Path | Purpose |
|------|---------|
| `README.md` | High-level project summary and quick start |
| `apps/api/` | Fastify API for activity catalog, user settings, sync ingest, and later reporting |
| `apps/desktop/` | Planned Tauri desktop tray app for Cinnamon-first activity capture |
| `apps/web/` | Vite-based manager-dashboard workspace for local browser testing and future reporting views |
| `packages/contracts/` | Shared Zod schemas and TypeScript types for API and clients |
| `docs/architecture.md` | Core system design and product constraints |
| `docs/product-workflow.md` | Expected user and manager workflows |
| `docs/platform-support.md` | Cinnamon-first support notes and GNOME/Windows follow-on guidance |
| `docs/development-setup.md` | Local setup and current developer commands |
| `docs/workflow.md` | Branching and slice-delivery guidance |
| `docs/adr/` | Architecture decision records |
| `infra/docker-compose.yml` | Local PostgreSQL scaffold for later persistence work |

## Runtime Target

The current intended runtime model is:

- `DDNUC-11` hosts the central API and PostgreSQL datastore
- the future dashboard is served from office-hosted infrastructure and viewed from the office LAN
- home-based employees reach only the API through a secure remote office-network path
- PostgreSQL is never treated as a shared desktop-access database

## Development Commands

Use the root workspace commands unless there is a good reason to target a single workspace.

```bash
npm install                      # Install workspace dependencies
npm run typecheck               # Validate contracts and API TypeScript
npm run build                   # Build contracts and API
npm run dev:api                 # Start the API in watch mode
npm run dev:web                 # Start the local Vite dashboard shell
```

There is no desktop build yet. The web workspace now exists as a local Vite shell; do not invent additional commands beyond the current repo state.

## Current Stack

### Implemented now

- Node.js 22+
- npm workspaces
- TypeScript in strict mode
- Fastify for the API
- Vite + React for the initial web shell
- Zod for shared schemas and validation

### Planned next

- Tauri v2 for the desktop tray app
- React + TypeScript for the web dashboard
- PostgreSQL as the authoritative datastore
- Per-user local SQLite in the desktop app for offline queueing

## Product Rules

These rules are core to the app and should not be casually bypassed.

1. Desktop clients do not write directly to a shared database or network file. The API owns validation, idempotency, and persistence.
2. Activity history is append-only at the event level. Session totals and durations are derived centrally.
3. The system-managed `Not Timed` activity must always exist as the default non-timed state.
4. User display names are normalized to Propercase.
5. Manager dashboard access must be filtered server-side by role and scope.
6. Cinnamon is the first-class desktop target. GNOME and Windows must be handled deliberately, not assumed to behave the same.

## Code Patterns

### Contracts first

- When changing request or response payloads, update `packages/contracts/` first.
- Keep API parsing and return shapes aligned with the shared Zod schemas.
- Prefer adding explicit schemas over ad hoc object shapes inside handlers.

### API design

- Keep route handlers thin and move business rules into helper modules when logic grows.
- Treat runtime validation failures as normal client errors and return structured 4xx responses.
- Keep the API authoritative for user settings, activity definitions, sync acknowledgements, and later reporting scope.

### Desktop design

- The Cinnamon tray UX should be menu-driven first.
- Do not depend on Linux tray click-event semantics for core flows.
- First-run onboarding should route users into settings before timed capture begins.
- Desktop-side local persistence should stay per-user.

### Activity model

- User-managed activities are timed activities.
- `Not Timed` is system-managed and non-removable.
- Selecting a timed activity should end the previous timed activity and start the new one at the same interaction timestamp.

## Critical Repo Rules

1. `npm run typecheck` must pass after code changes unless the repo grows a narrower targeted check for the touched slice.
2. `npm run build` must pass before shipping unless the change is docs-only or infrastructure-only under the TCTBP profile.
3. Keep instructions and docs aligned with the real repo state. Remove stale guidance instead of leaving copied placeholders.
4. Prefer focused modules over oversized route files or contract files when logic becomes hard to scan.
5. Do not document commands, files, or platform behaviour that the repo does not yet implement.
6. Preserve the central API write-path model; do not regress toward direct shared-datastore desktop writes.

## Documentation Expectations

When behaviour changes, review the docs that match the change:

- `README.md` for the repo summary and quick start
- `docs/architecture.md` for system design and behavioural constraints
- `docs/product-workflow.md` for end-user and manager workflows
- `docs/platform-support.md` for Cinnamon, GNOME, and Windows implications
- `docs/development-setup.md` for local commands and prerequisites
- `docs/workflow.md` for slice-based repo workflow
- `docs/adr/*.md` when the architectural decision itself changes

## Branch Guidance

Follow the repo workflow already documented in `docs/workflow.md`:

- `main` is the reviewed integration branch.
- `slice/*` is preferred for focused delivery work.
- `spike/*` is preferred for short-lived research or platform validation.

## Practical Guidance For Copilot

- Review the existing docs before introducing new product rules.
- If the repo only has API and contracts implemented, keep edits grounded there instead of inventing desktop code that does not exist yet.
- When adding a future desktop or web workspace, update this file so the command list, structure, and TCTBP profile stay accurate.
- Preserve the office-hosted runtime assumption unless the user explicitly changes deployment direction.