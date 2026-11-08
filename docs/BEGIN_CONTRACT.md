# Shared Begin contract 1

TCTBP owns the deterministic Begin core, contract, native skill template and
conformance tests in `packages/begin`. A command adapter owns only command
registration, selected-checkout resolution and presentation. Each project owns
`.github/TCTBP_BEGIN.json`, its mode, repository identity and optional peer/data
adapters. Deployment tooling owns immutable release pins and receipts.

The command is `node scripts/tctbp-run-begin.cjs --json`. Consumers carry the
complete pinned `scripts/tctbp-begin` runtime, so they remain self-contained.
DSH uses an identical release of that core and rejects mismatching project pins.
No installed command executes legacy resume/ticket workflows as a fallback.

## Modes and outcomes

`inspect` and `orient` inspect cached Git state and read the actual continuation.
`resume` may fetch origin and fast-forward only the selected current branch.
Dirty work, detached HEAD, Git operations or divergence stop resume. Local ahead
work remains local and is not a complete handoff. A metadata-directed branch
switch requires exact branch/source/target commit approval and cannot move a
branch belonging to another worktree. There is no checkpoint/stash/rebase/push.

Continuations are selected by the commit that last changed each file across
relevant cached refs, not filename or mtime. The exact content and provenance
are returned without checking out another branch. Missing continuation remains
incomplete. Reading a next step grants no authority to execute it.

`--no-actions` and `--preview` perform no fetch, live peer call or data workflow.
`--no-sync` skips only the declared data capability; required data stays SKIPPED
and handoff incomplete. Unknown/repeated flags stop before actions.

Results distinguish Git, peers, data, freshness, overall state and
`handoffComplete`. Only verified READY/NOT_APPLICABLE components with a read
continuation complete a handoff. An adapter exit code alone proves nothing.
Failures preserve earlier observations and partial-write evidence.

## Optional adapters and approval

Peer protocols must bind each saved-work handover to one fresh exact preview:
selected source/destination identities, full commits/branches, paths/exclusions,
remotes, independently verified recovery copies, configuration/controller/release
and all enrolled peer snapshots. One eligible source at most; multiple sources
or unfinished work plus an unknown peer block. Approval expires on changed
evidence. Explicit continuation past only-unknown peers retains unverified names.
No ordinary Begin request approves a remote checkpoint or publication.

Data adapters run only after fresh pinned Git READY. A strict committed-data
adapter must independently verify its physical development bindings and
incoming manifest in that exact commit, then use native preview/expected-plan
apply/final ticket and Git verification. Missing binding/manifest returns BLOCKED
before invoking native data commands. Settings outcomes remain separate. No
generic ticket pull, production write, fabricated manifest/baseline or implicit
service restart is part of the common contract. Other projects declare `none`.

## Distribution and compatibility

Keep existing project policy, intentional forks, command names and unrelated
skill metadata. A repo profile is additive; it does not replace the broader
TCTBP policy. Missing/unsupported profiles remain labelled inspect only. Archived
checkouts and historical worktrees are not silently migrated. Pin source commits,
file hashes and actual loaded command revisions separately; a package version
or disk symlink does not prove what an already-running host loaded.

The core modules separate argument parsing, process execution, project policy,
Git state/actions, continuation reads, optional adapters and coordination.
Tests use temporary real Git remotes and independently check observable state.
The intentionally separate project adapters retain their existing data and
remote-handshake guards rather than copying an application runtime into TCTBP.

## Incremental design review

The larger existing TCTBP Agent reference remains intact: this change adds only
the Begin route and trigger entries, with the detailed contract kept here. Its
remaining milestone workflows are one maintained reference and are not refactored
for this change. The new core has explicit I/O and pure parsing/policy boundaries;
no module imports an application or a DSH SDK. Consumer runtime copies retain
exact source hashes and conformance fixtures. Shared development policy bytes
and all unrelated workflow fields remain unchanged.

Run the vendored conformance suite with `npm --prefix scripts/tctbp-begin test`.
Its `*.node.cjs` files use Node's test runner and stay outside Vitest's default
test discovery. The canonical package adds adoption and installed-launcher tests.

## Host fallback and discovery

A verified host release may install the pinned `tctbp-begin` launcher and a user
Begin fallback for repositories without an adopted native entry. Both consume
the same core/profile contract; missing capabilities permit inspection only.
Repository and user skills sharing a name can both appear in selectors and are
not merged ([official skill discovery documentation](https://learn.chatgpt.com/docs/build-skills)).
Keep source, installed payload and actual loaded registration identities distinct.

Adoption preserves a consumer's older generic activation/catalogue unless that
surface is deliberately upgraded together. The additive Begin profile and native
skill/DSH entry provide the command; TCTBP-Web upgrades its complete factory
catalogue and scaffold inventory together.
