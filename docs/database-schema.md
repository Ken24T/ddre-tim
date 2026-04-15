# Database Schema

## Workbook Review

The external workbook `TiM Metrics.xlsx` was reviewed using the `TiM Records` tab.

Observed columns:

- `Date`
- `Week`
- `Month`
- `Employee`
- `Department`
- `Activity`
- `Hours`

Observed characteristics of the reviewed tab:

- 420 records
- Date range `2024-06-10` to `2024-10-04`
- 13 unique employees
- 9 unique departments
- 29 unique activities
- No duplicate records at the grain `Date + Employee + Department + Activity`
- Import logic should treat workbook dates using Australian regional conventions, so ambiguous textual dates must be parsed as day-first
- `Month` matched the month derived from `Date` for every row reviewed
- Some employees appear in multiple departments, so department belongs on the work record, not only on the user profile
- `Hours` values are decimal and not limited to quarter-hour increments, so imported summary hours should use a decimal type rather than an integer assumption

## What This Means

The workbook tab is a daily reporting extract, not a raw event log.

That means it is useful for:

- understanding reporting grain
- shaping import tables for historical data
- confirming that department is a reporting dimension

It should not be used as the primary live schema for the new application because the product rules already require append-only activity events and centrally derived sessions.

## Fields To Keep Derived

These workbook fields should not be stored as authoritative source columns in the live activity model:

- `Week`: derive from the work date or session start date
- `Month`: derive from the work date or session start date
- `Hours`: derive for live application data from start and end timestamps or stored session durations

`Hours` may still be stored in a historical import table because legacy data already arrives as daily summarized hours rather than event timestamps.

## Recommended Core Tables

### `users`

Purpose: people who record activity or view reporting.

Suggested columns:

- `id` UUID primary key
- `display_name` text not null
- `normalized_display_name` text not null
- `default_department_id` UUID nullable references `departments(id)`
- `is_active` boolean not null default true
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Notes:

- `display_name` should be stored in Propercase.
- Do not lock a user to a single department in the core table because the workbook shows at least some people crossing departments.
- `default_department_id` is a convenience default for new activities and onboarding, not a restriction on later event or activity department selection.

### `departments`

Purpose: reporting and access-control scope.

Suggested columns:

- `id` UUID primary key
- `slug` text unique not null
- `name` text unique not null
- `is_active` boolean not null default true
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

### `activities`

Purpose: timed and non-timed activity definitions.

Suggested columns:

- `id` UUID primary key
- `slug` text unique not null
- `name` text not null
- `kind` text not null check in (`timed`, `non-timed`)
- `is_system` boolean not null default false
- `is_active` boolean not null default true
- `department_id` UUID nullable references `departments(id)`
- `created_by_user_id` UUID nullable references `users(id)`
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Notes:

- Keep `Not Timed` as a single system-managed `non-timed` activity.
- `department_id` should remain nullable because some activities may be shared across departments.

### `user_activity_assignments`

Purpose: each user's curated tray menu list.

Suggested columns:

- `user_id` UUID not null references `users(id)`
- `activity_id` UUID not null references `activities(id)`
- `sort_order` integer not null default 0
- `is_hidden` boolean not null default false
- primary key (`user_id`, `activity_id`)

Notes:

- This supports the product rule that users can CRUD their own department-appropriate activity list without duplicating the activity definition itself in every event row.

### `devices`

Purpose: desktop installations that emit events.

Suggested columns:

- `id` UUID primary key
- `user_id` UUID not null references `users(id)`
- `device_key` text unique not null
- `platform` text not null
- `last_seen_at` timestamptz nullable
- `created_at` timestamptz not null

### `activity_events`

Purpose: append-only source of truth for live usage.

Suggested columns:

- `id` UUID primary key
- `user_id` UUID not null references `users(id)`
- `device_id` UUID not null references `devices(id)`
- `department_id` UUID nullable references `departments(id)`
- `activity_id` UUID nullable references `activities(id)`
- `event_type` text not null check in (`activity-selected`, `activity-cleared`, `note-added`)
- `occurred_at` timestamptz not null
- `recorded_at` timestamptz not null
- `idempotency_key` text unique not null
- `note` text nullable
- `metadata` jsonb not null default `'{}'::jsonb`

Notes:

- `department_id` belongs on the event because the workbook shows the same person may work across departments.
- Live durations should be derived by pairing sequential events rather than entered directly.

### `manager_scopes`

Purpose: server-side dashboard authorization.

Suggested columns:

- `id` UUID primary key
- `manager_user_id` UUID not null references `users(id)`
- `scope_type` text not null check in (`department`, `all`)
- `department_id` UUID nullable references `departments(id)`
- `created_at` timestamptz not null

Notes:

- `scope_type = all` is suitable for a business-owner role.
- `scope_type = department` is suitable for managers limited to one department.

## Recommended Derived Structures

### `activity_sessions`

Purpose: derived sessions produced from ordered events.

Suggested columns or view fields:

- `id`
- `user_id`
- `department_id`
- `activity_id`
- `started_at`
- `ended_at`
- `duration_seconds`
- `start_event_id`
- `end_event_id`

### `daily_activity_hours`

Purpose: dashboard-friendly daily totals by user, department, and activity.

Suggested fields:

- `work_date`
- `user_id`
- `department_id`
- `activity_id`
- `hours`

Notes:

- `Week` and `Month` should be computed in queries or downstream views from `work_date`.
- This structure is the closest match to the reviewed workbook tab.

## Optional Historical Import Table

If the workbook data needs to be imported, use a separate staging or preserved-history table instead of forcing it into the live event source model.

### `historical_tim_daily_records`

Suggested columns:

- `id` UUID primary key
- `work_date` date not null
- `employee_name` text not null
- `department_name` text not null
- `activity_name` text not null
- `hours` numeric(6,2) not null
- `source_file` text not null
- `imported_at` timestamptz not null
- `mapped_user_id` UUID nullable references `users(id)`
- `mapped_department_id` UUID nullable references `departments(id)`
- `mapped_activity_id` UUID nullable references `activities(id)`

Notes:

- This table keeps the original reporting shape for auditability.
- It avoids corrupting the live event model with backfilled totals that never had explicit start and end timestamps.

## Historical Import Rules

For the current legacy import slice, only import rows belonging to `Ken Boyle`.

Import rules:

- Filter workbook rows by `Employee = Ken Boyle` after trimming surrounding whitespace and normalizing comparison case
- Preserve `Department` on every imported row because the same employee can legitimately perform work for multiple departments
- Parse `Date` using Australian regional conventions and store the normalized result in `work_date`
- Derive `Week` and `Month` after date normalization rather than trusting workbook labels as source-of-truth fields
- Keep imported `Hours` as historical daily totals only; do not fabricate live event timestamps from them
- Regenerate the current repo seed file with `npm run import:tim-records -- "/home/ken/Downloads/TiM Metrics.xlsx"`, which writes `infra/seeds/ken-boyle-historical-tim-records.json`

## Current Repo DB Artifacts

The repository now contains an initial SQL implementation of the recommended tables in `infra/sql/001_initial_schema.sql` and a generated historical seed load in `infra/sql/010_seed_ken_boyle_historical.sql`.

Current behavior of the generated seed:

- inserts a single Ken Boyle user row
- derives the user's default department from the imported department with the highest total hours
- inserts shared timed activities from the imported workbook rows plus the system-managed `Not Timed` activity
- loads all 368 Ken Boyle historical rows into `historical_tim_daily_records` with mapped user, department, and activity ids

Validation commands:

- `npm run db:generate-seed`
- `npm run db:validate`

## Recommended Direction For This Repo

For the new application, build the live database around `users`, `departments`, `activities`, `devices`, and append-only `activity_events`.

Then derive:

- sessions for operational logic
- daily totals for dashboard use
- weekly and monthly summaries from daily totals

Use the reviewed workbook format only as:

- a reference for manager reporting needs
- a target shape for reporting views
- a possible one-time historical import format