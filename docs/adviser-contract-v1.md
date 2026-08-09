# TCTBP Adviser Inspection Contract v1

## Purpose

The Adviser contract exposes stable, machine-readable TCTBP observations without
requiring a client to parse terminal tables or import runner modules.

Human-readable status remains the default:

```bash
node scripts/tctbp-run-status.js --no-fetch
```

Contract output is explicit and non-fetching:

```bash
node scripts/tctbp-run-status.js --json --no-fetch
```

`--json` requires `--no-fetch`. A successful inspection exits `0`, including
when the observed repository state requires investigation or blocks a workflow.
A runner or contract failure exits non-zero and still emits one JSON document
containing a stable error code.

## Compatibility

The contract advertises:

- a breaking `major` version;
- an additive `minor` version;
- independently negotiable capability identifiers;
- the schema path for the emitted document.

Consumers must reject unsupported major versions, ignore unknown additive
fields, and disable only the features whose capability identifiers are absent.
The TCTBP profile schema version is reported separately and must not be used as
a substitute for Adviser contract compatibility.

Contract v1 capabilities are:

- `inspection.local-v1`
- `workflow-catalogue.core-v1`
- `reason-codes.core-v1`

## Evidence boundaries

The contract separates the local working copy from locally cached
`refs/remotes/origin/*` tracking refs. With `--no-fetch`, tracking freshness is
reported as `unknown`; it is not presented as current GitHub truth.

The output intentionally excludes absolute repository paths, dirty filenames,
credentials, environment variables, and repository command strings.

## Stable vocabulary

Stable reason codes and guardrail identifiers are declared in
`.github/TCTBP.json`. Human wording may evolve without changing these
identifiers.

The workflow catalogue is generated from the existing TCTBP policy. It reports
whether a workflow is installed and policy-enabled; it does not grant
permission to execute that workflow.

## Schemas and fixtures

- Schema: `schemas/tctbp-adviser-inspection-v1.schema.json`
- Fixtures: `contracts/adviser-v1/fixtures/`

The fixtures cover simple, staged, and long-lived environment branch models.
Unknown additive fields remain schema-valid by design.

## Security boundary

Contract v1 is observational. It does not execute mutating workflows, update
TCTBP scaffolding, or run repository-provided inspection code on behalf of an
external service.

An Adviser may use contract and profile metadata to assess whether a target
repository's TCTBP installation is current and compatible. Any future update
facility must use a pinned, trusted TCTBP-Web migration, show the proposed diff,
require explicit per-repository approval, and remain outside the read-only MVP.
