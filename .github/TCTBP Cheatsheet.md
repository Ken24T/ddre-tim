# TCTBP Developer Cheatsheet

Short operator reference for the ddre-tim repository workflows.

Use this file for the quick view.
Use [TCTBP Agent.md](TCTBP%20Agent.md) for the full workflow rules and guard rails.

## Core Rule

- No code is ever lost while syncing local and remote state.
- Do not use destructive shortcuts as part of normal workflow execution.
- If a workflow hits divergence, ambiguity, or a failed invariant, it should stop rather than guess.

## Repo Gates

Repo gates for this repository:

- Format check: `n/a`
- Test: `npm run typecheck`
- Lint: `n/a`
- Normal build gate: `npm run build`
- Runtime or deployment build: `n/a`

## Triggers

### `ship` / `ship please` / `shipping` / `prepare release`

Purpose:
Formal source release workflow.

Attempts to:

- preflight the repo state
- show a concise origin-vs-local snapshot table before mutating anything
- run verification gates
- confirm zero problems
- assess docs impact
- bump version when required
- commit the release changes
- create the version tag
- push the current branch

Use when:

- you want a formal shipped version
- version and tag state needs to be updated
- the repo should be published as a release milestone

Notes:

- Starts with a four-column table: `Origin`, `Local`, `Status`, `Action(s)`
- Table should explicitly include rows such as tag state and commits ahead/behind
- Uses the normal build gate by default, not the release build
- Patch bump behaviour is controlled by `versioning.patchEveryShip` and `versioning.patchEveryShipForDocsInfrastructureOnly` in `TCTBP.json`
- In this repo, docs-only and infrastructure-only ships still receive a patch bump
- Release build is reserved for installation or deployment scenarios
- Stops if the branch is dirty, behind origin, or diverged from origin
- May publish a clean branch that has no upstream yet by creating the upstream on the first ship push
- Stops if `HEAD` is detached
- Does not treat a bare `tctbp` request as permission to mutate repository state

### `publish` / `publish please`

Purpose:
Safely publish the current branch to `origin` without release semantics.

Attempts to:

- preflight the current branch state
- fetch and compare local versus origin
- allow first publication by creating the upstream when needed
- push the current branch when it is clean and ahead
- verify that the branch is now synced

Use when:

- you want to sync the current branch to origin without bumping version or creating a tag
- you want to publish a clean fresh branch before using `branch` or `branch <new-branch-name>` later

Notes:

- Does not bump version
- Does not create a tag
- Does not update handover metadata
- Stops if the branch is dirty, behind, diverged, or detached

### `checkpoint` / `checkpoint please`

Purpose:
Create a durable local-only checkpoint commit on the current branch without release or sync side effects.

Attempts to:

- preflight the current branch and working tree state
- stop if `HEAD` is detached, the tree is clean, conflicts exist, or a merge/rebase/cherry-pick/revert is in progress
- stage the current non-ignored tracked and new files
- create a clearly marked non-release local commit
- end with a concise four-column table showing the pre-checkpoint commit, the new checkpoint commit, resulting sync state, and explicit local-only outcome
- confirm that nothing was pushed, tagged, or handed over

Use when:

- you want safer local slice checkpoints during a long session
- you do not want to sit on uncommitted work for long
- you want a durable local save before deciding whether to `publish`, `handover`, or `ship`

Notes:

- Ends with a concise four-column table: `Origin`, `Local`, `Status`, `Action(s)`
- The table should show the actual pre-checkpoint commit and the new checkpoint commit, not only the final SHA
- Does not push
- Does not bump version
- Does not create a tag
- Does not update handover metadata
- Does not reconcile with origin
- May leave the branch ahead of or further diverged from origin because it is local-only
- Handover may reuse a recent matching checkpoint commit instead of creating another one

### `handover` / `handover please`

Purpose:
Safely checkpoint and publish the current work branch at the end of a session, then refresh handover metadata so another machine can resume deterministically.

Scope:

- syncs the current work branch, a dedicated handover metadata branch, and relevant tags only
- does not reconcile every branch in the repository
- does not merge into `main` as part of normal machine-to-machine sync

Handover metadata:

- metadata branch: `tctbp/handover-state`
- metadata file: `.github/TCTBP_STATE.json`
- stores the last successfully handed-over work branch and commit
- is consulted before branch-recency inference on another machine
- is never treated as a work-branch candidate itself

Attempts to:

- preserve dirty work on the current branch when needed
- create a durable checkpoint for dirty unpublished work before verification can strand it on one machine
- fetch and inspect remote state
- fast-forward when remote is ahead and local is clean
- publish the current branch when local is ahead or still unpublished
- stop on divergence or unresolved blockers
- update the metadata branch after current-branch publication succeeds
- push relevant tags when appropriate
- confirm that the current branch and metadata branch are both in sync

Notes:

- Ends with a concise four-column table: `Origin`, `Local`, `Status`, `Action(s)`
- Keep the handover table to five rows focused on branch sync, latest tag, metadata branch publication, metadata consistency, and final baseline state
- Use a short completion line after the table to confirm the handed-over branch and commit
- Update the metadata branch using a secondary worktree or another equally non-destructive method
- May reuse a recent matching standalone `checkpoint` commit instead of creating another one
- Stops if `HEAD` is detached

Use when:

- you are finishing work on one machine
- you are finishing a work session and want another machine to resume cleanly
- you want one trusted end-of-day sync command before stopping work

Never does:

- auto-rebase
- hard reset
- destructive checkout
- force-push

### `resume` / `resume please`

Purpose:
Safely restore the intended work branch at the start of a session, preserving local unpublished work first when a safe branch switch would otherwise strand it.

Attempts to:

- fetch and inspect remote state
- read the handover metadata branch first
- prefer metadata over arbitrary branch-recency guesses
- detect when switching would strand local unpublished work on the current branch
- ask to preserve that local work locally before switching when that case is safe
- create a local tracking branch from the intended remote branch when needed
- fast-forward the selected clean branch when origin is ahead
- stop on ambiguity, divergence, conflicts, or any case that would require publication

Use when:

- you are starting work on another machine
- you want to restore the last handed-over branch safely before making new changes

Notes:

- May create a local-only checkpoint or rescue branch after confirmation to preserve local work before switching
- Does not publish
- Does not update metadata
- Does not create a release
- Stops if preserve-local handling would be unsafe, if switching branches would still be destructive, or if local/remote state is ambiguous

### `deploy` / `deploy please`

Purpose:
Fail immediately because this repository does not yet define a deploy target.

Attempts to:

- preflight the repo state
- read the deploy policy from `.github/TCTBP.json`
- stop immediately with the repo-specific failure message
- leave branch, version, tag, and runtime state unchanged

Use when:

- you want a clear reminder that deploy is intentionally disabled until a repo-specific target exists

Repo-specific deploy target:

- none currently configured

Current deploy policy:

- `enabled: false`
- `stopImmediately: true`
- `requireCleanTree: true`
- `requireSyncedBranch: true`
- `requireShipFirst: false`
- `migrationCommand: null`

Deploy guard rails:

- deploy must fail before running build, install, publish, or migration commands
- detached `HEAD` should stop deploy
- destructive replacement without rollback expectations should stop deploy

### `status` / `status please`

Purpose:
Read-only operator snapshot of branch state, sync status, tags, and recommended next steps.

Use when:

- you want to know whether `resume`, `checkpoint`, `publish`, `handover`, `ship`, or `abort` is needed before doing anything else

Notes:

- This trigger must begin with the fuller four-column comparison table: `Origin`, `Local`, `Status`, `Action(s)`
- Table should explicitly include branch state, default-branch state, tag state, ahead/behind counts, working tree, and whether `resume`, `checkpoint`, `publish`, `ship`, or `handover` is recommended
- Recommendations come after the table, not before it
- If metadata points another machine at the wrong published branch, call that out as a resume-target mismatch

### `abort`

Purpose:
Inspect and recover from a partially completed SHIP, sync, or deploy workflow.

Use when:

- a prior workflow stopped part-way through
- version, tag, merge, or push state looks inconsistent
- branch publication and handover metadata disagree
- a version bump, changelog update, or tag exists without the rest of the release state
- `main` and a newly created branch are only partially published after a branch workflow

Recovery expectations:

- inspect concrete partial states before proposing action
- preserve unpublished work before cleanup when needed
- never rewrite history or force-push without explicit extra confirmation

### `branch` and `branch <new-branch-name>`

Purpose:
Close out current work cleanly and either stop on `main` or start the next branch.

Attempts to:

- assess whether the current branch should be shipped first
- stop if `HEAD` is detached
- in next-branch mode, stop if the requested new branch name is invalid or equals `main`
- in next-branch mode, auto-rename the requested branch to `-1`, `-2`, and so on when the requested name already exists locally, already exists remotely, or would collide by case
- stop instead of switching if the current branch is dirty and SHIP is declined
- recommend `checkpoint`, then `publish` or `handover`, when the current branch is dirty and you need a non-release preservation step before retrying `branch`
- stop instead of guessing if the source branch or local `main` is diverged
- stop if the source branch is ahead, behind, or otherwise not yet synced to its upstream
- recommend `publish`, `handover`, or `ship` first when the source branch is not yet published or synced
- ask for explicit confirmation before merging the current non-default branch back into `main`
- merge the current branch into local `main` when the current branch is not already `main`
- skip the merge step when you already start on `main`
- in bare `branch` mode, stop on updated local `main`
- in `branch <new-branch-name>` mode, create and switch to the resolved branch name from updated local `main`

Safety expectation:

- never discards local work to complete the transition
- never uses stash, reset, rebase, force-push, or destructive checkout as part of the branch workflow
- requires the source branch to be published before branch closeout continues
- treats merge back to `main` as the expected default path, but stops if that merge is explicitly declined
- only offers old-branch deletion after the merge succeeded and source reachability from `main` is confirmed; next-branch mode also requires new-branch creation first

## Handover Promise

When `handover` succeeds:

- the current work branch has been safely reconciled with `origin`
- the handover metadata branch points at that branch and handed-over commit
- relevant tags have been pushed when needed
- the next `resume` can restore the intended branch deterministically
- if the workflow could not do that safely, it stops instead of guessing
- no implicit merge to `main` was performed as part of that sync

## Docs Impact Reminder

Review docs when the change touches:

- user-visible features
- UI or interaction
- config or settings
- packaging or metadata
- roadmap or status

Repo-specific docs commonly reviewed:

- `README.md`
- `docs/architecture.md`
- `docs/product-workflow.md`
- `docs/platform-support.md`
- `docs/development-setup.md`
- `docs/workflow.md`
- `.github/copilot-instructions.md`

## Deployment Notes

- `npm run typecheck` is the main verification gate for contract and API changes
- `npm run build` is the normal build gate
- There is no formatter or lint gate configured yet
- There is no separate release-build command at present
- Deploy is intentionally disabled until the repo defines a concrete runtime target, rollback plan, and post-deploy validation path
- Use the repo-defined workspace commands instead of inventing desktop or web build steps before those workspaces exist

## Approval Model

- `ship` may create local commit and tag state as part of the workflow
- `checkpoint` creates a local-only non-release commit and grants no push approval
- `publish` grants approval to push the current branch for that workflow only
- `handover` grants approval to push the current branch, metadata branch, and relevant tags for that workflow only
- `deploy` grants approval to run the repo-defined deployment commands for that workflow only
- Any other remote push still requires explicit approval unless already covered by the active workflow

## Quick Choice

- Need a release version or tag: use `ship`
- Need a durable local-only save without publishing: use `checkpoint`
- Need to publish the current branch without release side effects: use `publish`
- Need to stop on one machine and resume on another safely: use `handover`, then `resume` on the next machine
- If `resume` hits local unpublished work on the current machine, it should offer a local preserve step before switching
- Need deployment later: `deploy` is currently disabled until a repo-specific target exists
- Need a quick repo state check: use `status`
- Need to recover from partial workflow state: use `abort`
- Need to close out current work and stop on `main`: use `branch`
- Need to start the next branch: use `branch <new-branch-name>`
