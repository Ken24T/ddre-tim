# ADR 0002: Write Path and Sync

## Status

Accepted

## Decision

Desktop clients write activity events to the API, not directly to a shared datastore.

## Rationale

- Multiple users need a central authority for validation and concurrency.
- Offline capture requires queued sync and idempotent replay.
- Reporting should be derived centrally from event history.

## Consequences

- The desktop app needs a local outbox.
- The API needs idempotency and conflict handling.
- PostgreSQL is the authoritative datastore target.