# TCTBP-Web Cheatsheet

Short operator reference for the TCTBP-Web workflows.

Use this file for the quick view.
Use [TCTBP Agent.md](TCTBP%20Agent.md) for the full workflow rules and guard rails.

## Concise Cheat Sheet

| Trigger family | Primary command path | Mutates repo? |
| --- | --- | --- |
| status | `node scripts/tctbp-run-status.js [--suggest]` or `--json --no-fetch` | No |
| preflight | `node scripts/tctbp-run-preflight.js` | No (non-mutating) |
| checkpoint | `node scripts/tctbp-run-checkpoint.js` | Local commit only |
| publish | `node scripts/tctbp-run-publish.js` | May push current branch |
| handover | `node scripts/tctbp-run-handover.js` | May checkpoint + publish |
| handover local | `node scripts/tctbp-run-handover.js --local-only` | Local commit only |
| resume | `node scripts/tctbp-run-resume.js` | Local sync only |
| orient | `node scripts/tctbp-run-orient.js` | No |
| promote | `node scripts/tctbp-run-promote.js <staging\|review\|production>` | Local/remote per target policy |
| deploy | `node scripts/tctbp-run-deploy.js <dev\|staging\|review\|production>` | Local/remote per target policy |
| release | `node scripts/tctbp-run-release.js --no-docs-impact "<reason>"` | Full pipeline compose |
| ticket | `node scripts/tctbp-run-ticket.js <create\|report\|triage> ...` | `create` writes only with `--apply` |
| branch | `node scripts/tctbp-run-branch.js [new-branch-name]` | Local merge/branch ops |
| ship | `node scripts/tctbp-run-ship.js --no-docs-impact "<reason>" --yes` | Commit/tag/push on `main` |
| hotfix | `node scripts/tctbp-run-hotfix.js {start \| finish}` | Creates hotfix branch; merges, ships, and backports |
| abort | `node scripts/tctbp-run-abort.js --dry-run` | Preview by default |
| gate | `node scripts/tctbp-run-gate.js <test\|lint\|build>` | No (unless gate command writes) |
| version | `node scripts/tctbp-run-version.js [--strict]` | No |
| rollback | `node scripts/tctbp-run-rollback.js [--apply]` | Local revert commit with `--apply` |
| scaffold | `node scripts/tctbp-run-scaffold.js [--defaults]` | Creates new project |

Quick safety notes:

- Preview-first workflows: `checkpoint --dry-run`, `publish --dry-run`, `handover --dry-run`, `abort` (default), `rollback` (default), `status --suggest`, `scaffold --dry-run`.
- Machine-readable status is explicitly non-fetching: `node scripts/tctbp-run-status.js --json --no-fetch`.
- Remote mutation workflows: `publish`, `handover`, `promote staging`, selected deploy targets, and `ship` on `main`.
- `rollback` always uses `git revert`, never history rewrite.
- `scaffold` creates a new directory/project outside the current repo.

## Core Rule

- No code is ever lost while syncing local and remote state.
- Do not use destructive shortcuts as part of normal workflow execution.
- If a workflow hits divergence, ambiguity, or a failed invariant, it should stop rather than guess.

## Branch Model

Three strategies, configured in `TCTBP.json` under `branchModel.strategy`:

**Simple** (`"simple"`): Single production branch (`main`). Used by TCTBP-Web itself and libraries.

**Staged** (`"staged"`): Three environment branches:

- `development` — day-to-day working branch
- `staging` — field-testing and review branch
- `main` — production release branch

**Long-lived environment branches** (`"long-lived-environment-branches"`): Three named branches with explicit promote and deploy:

- `development` — daily coding and internal verification
- `review` — user field testing
- `main` — production releases

Promotion is a merge step between these branches. Deployment never performs the promotion merge for you.

## Repo Gates

Repo gates are configured in `TCTBP.json` under `profile.commands`. Gates report "not configured" gracefully when the corresponding command is null.

Typical scaffolded project gates:

- Test: `npm run test`
- Lint: `npm run lint`
- Build: `npm run build`
- Format: `npx prettier --check .`

## Triggers

### `scaffold` / `scaffold web` / `new project` / `create project`

Purpose: Create a new web project with the full TCTBP-Web runtime surface.

Attempts to:

- Conduct an interactive interview (6 questions)
- Create the project directory with skeleton files
- Install the complete TCTBP-Web runner surface
- Generate a populated `TCTBP.json` profile
- Initialize git and create the branch structure
- Open on the working branch ready for development
- Smoke-test the installed runners

Notes:

- The scaffolded project opens on the working branch (default: `development`).
- The generated profile is fully populated — no placeholders to fill in.
- Test scaffolding (Vitest by default) is included so the test gate passes on day one.

### `ship` / `ship please` / `shipping`

Purpose: Formal shipped version workflow. Reserved for `main`.

Executable path: `node scripts/tctbp-run-ship.js --no-docs-impact "<reason>" --yes`

### `release` / `release please` / `prepare release` / `prepare release please`

Purpose: Run or resume the staged deploy → promote → ship pipeline with an atomic release journal and commit/tree candidate revalidation. `prepare release` routes to release, not ship.

Executable paths:

- `node scripts/tctbp-run-release.js --no-docs-impact "<reason>"`
- `node scripts/tctbp-run-release.js --resume`

The generic runner does not assume DDRE backup, restore, systemd, or runtime-storage behaviour. Downstream projects supply those integrations separately.

### `preflight` / `preflight please`

Purpose: Non-mutating aggregate verification of the current working state before preserving, publishing, handing over, promoting, deploying, or otherwise advancing. Reports PASS / FAIL / NOT-CONFIGURED and detects side effects caused by verification commands.

Executable path: `node scripts/tctbp-run-preflight.js`

### `hotfix` / `hotfix start` / `hotfix finish` / `emergency fix`

Purpose: Emergency-lane production fix that bypasses the normal promote-review-promote-production flow.

Executable paths:

- `node scripts/tctbp-run-hotfix.js start <name>` — create `hotfix/<name>` from `main`
- `node scripts/tctbp-run-hotfix.js finish --no-docs-impact "<reason>"` — merge hotfix to `main`, ship, and backport to pre-production and working branches

Notes:

- `finish` always ships with `--bump patch` unless another bump is supplied.
- `finish` pushes the shipped `main` branch, then backports it to the configured pre-production and working branches and pushes those.

### `publish` / `publish please`

Purpose: Safely publish the current clean branch to `origin` without release semantics.

Executable path: `node scripts/tctbp-run-publish.js`

### `checkpoint` / `checkpoint please`

Purpose: Create a durable local-only checkpoint commit.

Executable path: `node scripts/tctbp-run-checkpoint.js`

### `handover` / `handover please` / `handover local` / `handover local please`

Purpose: Safely checkpoint and sync the active branch for machine handoff.

Executable path: `node scripts/tctbp-run-handover.js`

### `resume` / `resume please`

Purpose: Restore a safe working baseline after switching machines.

Executable path: `node scripts/tctbp-run-resume.js`

### `promote staging` / `promote production` / `promote prod`

Purpose: Explicit merge between environment branches with code-loss prevention gates.

Executable path: `node scripts/tctbp-run-promote.js <staging|production> --no-docs-impact "<reason>"`

### `deploy dev` / `deploy staging` / `deploy prod` / `deploy production`

Purpose: Deploy the current environment branch to its mapped runtime environment.

Executable paths:

- `node scripts/tctbp-run-deploy.js dev --no-docs-impact "<reason>"`
- `node scripts/tctbp-run-deploy.js staging --no-docs-impact "<reason>"`
- `node scripts/tctbp-run-deploy.js production --no-docs-impact "<reason>"`

### `run tests` / `run lint` / `run build` / `gate test` / `gate lint` / `gate build`

Purpose: Run quality gates directly.

Executable path: `node scripts/tctbp-run-gate.js <test|lint|build>`

### `version status` / `version check`

Purpose: Report branch/version/tag alignment.

Executable path: `node scripts/tctbp-run-version.js [--strict] [--required-environment <development|staging|production>]`

### `rollback` / `revert last checkpoint`

Purpose: Safely revert the latest checkpoint commit.

Executable path: `node scripts/tctbp-run-rollback.js [--apply]`

### `abort`

Purpose: Inspect partial workflow state and propose recovery.

Executable path: `node scripts/tctbp-run-abort.js --dry-run`

## Handover Promise

When `handover` succeeds:

- the current work branch has been safely reconciled with `origin`
- relevant tags have been pushed when needed
- no implicit merge to staging or main was performed
- code-loss safeguards were applied to any merge step

## Docs Impact Reminder

Review docs when the change touches:

- user-visible features
- UI or interaction
- config or settings
- packaging or metadata
- roadmap or status

## Code-Loss Prevention

- Safety tags are created before every merge into a default or environment branch.
- Merge deletion audits run after every merge with configurable file/line thresholds.
- Pre-push net-deletion checks warn before destructive pushes.
- `rollback` always uses `git revert`, never history rewrite.

## Approval Model

- `ship` may create local commit and tag state as part of the workflow
- `checkpoint` creates a local-only non-release commit and grants no push approval
- `publish` grants approval to push the current branch for that workflow only
- `handover` grants approval to push the current branch and relevant tags for that workflow only
- `promote` grants approval to push the target branch after promotion for that workflow only
- `deploy` grants approval to run the repo-defined deployment commands for that workflow only
- `scaffold` creates a new project outside the current repo; no current-repo mutation
- Any other remote push still requires explicit approval unless already covered by the active workflow

## Quick Choice

- Need a new web project with TCTBP-Web: use `scaffold`
- Need a release version or tag: use `ship`
- Need a durable local-only save without publishing: use `checkpoint`
- Need to publish the current branch without release side effects: use `publish`
- Need to stop on one machine and resume on another safely: use `handover`, then `resume` on the next machine
- Need to merge development into staging: use `promote staging`
- Need to merge staging into main for release: use `promote production`
- Need to deploy a branch to its environment: use `deploy <dev|staging|production>`
- Need a quick repo state check: use `status`
- Need to recover from partial workflow state: use `abort`
- Need to undo the last checkpoint: use `rollback`
- Need to close out current work and stop: use `branch`
- Need to start the next branch: use `branch <new-branch-name>`
