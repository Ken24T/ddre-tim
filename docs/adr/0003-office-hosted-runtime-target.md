# ADR 0003: Office-Hosted Runtime Target

## Status

Accepted

## Decision

Time in Motion will target a zero-cost office-hosted runtime for the near term.

The shared runtime will live on `DDNUC-11` and host:

- the central API
- the authoritative PostgreSQL database
- the future TiM dashboard

The intended network shape is:

- office-based users access the dashboard and API from the office LAN
- employees working from home access only the API through a secure remote path into the office network
- PostgreSQL is not exposed directly to user workstations or the public internet

## Rationale

- The project currently requires a $0 hosting approach.
- An office-hosted machine is simpler for the current budget than a paid hosted API and managed PostgreSQL service.
- The existing architecture already expects a central API and authoritative server-side datastore rather than a shared desktop database file.
- Restricting dashboard usage to the office LAN narrows the first deployment surface and avoids turning the reporting UI into a general public web application prematurely.

## Consequences

- `DDNUC-11` becomes operationally important and needs basic hardening, backups, and restart strategy.
- Remote home workers still need a secure way to reach the office-hosted API, such as VPN or equivalent tunnel.
- PostgreSQL must remain private to the host or office network; desktop clients continue talking only to the API.
- Deployment work is still incomplete until the repo defines service management, database backup, rollback, and remote-access procedures for this office-hosted target.