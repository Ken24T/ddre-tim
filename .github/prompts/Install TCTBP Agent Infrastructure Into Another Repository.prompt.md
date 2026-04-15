---
description: "Use when the user explicitly asks for reconcile-tctbp <absolute-target-repo-path> so the current repository can inspect another repository, detect whether it is new, missing the agent runtime, or already using the agent runtime, and then reconcile that repository's TCTBP state safely."
name: "reconcile-tctbp"
argument-hint: "Absolute target repository path, plus optional source ref, target state or AUTO, backup mode, and whether to include the hook layer"
agent: "agent"
---

# reconcile-tctbp

Use this prompt inside a repository that already uses TCTBP when you want Copilot to handle an explicit `reconcile-tctbp <absolute-target-repo-path>` request and install, adapt, or refresh the TCTBP workflow and optional agent runtime in a different repository.

## Goal

Apply the current repository's TCTBP runtime surface to a target repository safely so that Copilot can choose the correct path for one of three cases:

- a brand new repository with no TCTBP files yet
- an existing repository that has some TCTBP workflow files but no custom agent runtime
- an existing repository that already has the custom agent runtime and needs to be refreshed from the current source repository

Depending on the detected or requested state, the target repository should gain or retain:

- a custom TCTBP agent entry point
- a machine-readable workflow policy
- aligned Markdown workflow guidance
- a single reusable TCTBP application prompt
- optional runtime hook enforcement for risky git commands
- an ignore rule that keeps local TCTBP file-backup artefacts out of normal commits

The current repository is the source of generic workflow logic.
The target repository is the source of repo-specific commands, paths, deployment details, and intentional local deviations.

## Required Inputs

Fill in these values before using the prompt.

Absolute paths may use Windows or POSIX syntax. Preserve the target repository's existing path style instead of rewriting it.

```text
Source TCTBP repository path: <ABSOLUTE_CURRENT_REPOSITORY_PATH_OR_OTHER_SOURCE_REPO>
Target repository path: <ABSOLUTE_TARGET_REPO_PATH>
Target repository state: <AUTO_OR_NEW_REPOSITORY_OR_EXISTING_REPOSITORY_WITHOUT_AGENT_OR_EXISTING_REPOSITORY_WITH_AGENT>
Preferred install/update branch in target repo: <BRANCH_NAME_OR_NULL>
Include hook layer: <YES_OR_NO>
Backup mode for existing repo: <NONE_OR_BRANCH_ONLY_OR_BRANCH_AND_FILE_BACKUPS>
Source ref to use from this repository: <CURRENT_BRANCH_TAG_OR_COMMIT>
Any repo-specific settings that must be preserved exactly: <LIST_OR_NONE>
Any intentional local workflow deviations that must not be normalised away: <LIST_OR_NONE>
```

## Source Files To Use From This Repository

Read these files from the current source repository first:

- `.github/agents/TCTBP.agent.md`
- `.github/TCTBP.json`
- `.github/TCTBP Agent.md`
- `.github/TCTBP Cheatsheet.md`
- `.github/copilot-instructions.md`
- `.github/prompts/Install TCTBP Agent Infrastructure Into Another Repository.prompt.md`

If `Include hook layer` is `YES`, also read:

- `.github/hooks/tctbp-safety.json`
- `scripts/tctbp-pretool-hook.js`

## Target Repository Evidence To Read Before Editing

Inspect the target repository before editing anything. Read the local versions of these files when they exist:

- `.gitignore`
- `.github/agents/TCTBP.agent.md`
- `.github/TCTBP.json`
- `.github/TCTBP Agent.md`
- `.github/TCTBP Cheatsheet.md`
- `.github/copilot-instructions.md`
- `.github/prompts/Install TCTBP Agent Infrastructure Into Another Repository.prompt.md`
- `.github/hooks/tctbp-safety.json`
- `scripts/tctbp-pretool-hook.js`

Also inspect the target repository's real operating context before editing, using whichever of these sources exist and are relevant:

- `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, or equivalent repo guidance
- project manifests and lock files
- version files and release scripts
- deploy or install scripts
- docs, runbooks, and architecture notes that the workflow references

Do not infer repo-specific settings from the current source repository when the target repository already contains stronger local evidence.

## Target Files To Create Or Update

Install or update these files in the target repository:

- `.gitignore`
- `.github/agents/TCTBP.agent.md`
- `.github/TCTBP.json`
- `.github/TCTBP Agent.md`
- `.github/TCTBP Cheatsheet.md`
- `.github/copilot-instructions.md`
- `.github/prompts/Install TCTBP Agent Infrastructure Into Another Repository.prompt.md`

If `Include hook layer` is `YES`, also install or update:

- `.github/hooks/tctbp-safety.json`
- `scripts/tctbp-pretool-hook.js`

## Installation Modes

### Auto-detect mode

If `Target repository state` is `AUTO`:

1. Inspect the target repository before editing.
2. Detect which state applies:
   - `NEW_REPOSITORY` when the target repo has no local TCTBP workflow files yet
   - `EXISTING_REPOSITORY_WITHOUT_AGENT` when workflow files exist but `.github/agents/TCTBP.agent.md` does not
   - `EXISTING_REPOSITORY_WITH_AGENT` when the custom agent entry point already exists
3. Report the detected state before editing.
4. If the evidence is ambiguous, stop and ask for clarification instead of guessing.

### New repository

If `Target repository state` is `NEW_REPOSITORY`:

1. Treat the target repository as not yet configured for TCTBP.
2. Create any missing `.github/agents`, `.github/hooks`, `.github/prompts`, and `scripts` folders as required.
3. Install the full TCTBP runtime surface in the target repository.
4. Adapt the canonical files to the target repository using the target repo's actual project details.
5. Replace placeholders or unresolved values only when the target repository contains enough evidence.
6. If key values are missing, leave them explicitly unresolved or ask for clarification rather than guessing.

### Existing repository without agent runtime

If `Target repository state` is `EXISTING_REPOSITORY_WITHOUT_AGENT`:

1. Read the target repository's existing workflow files first if they exist.
2. Preserve repo-specific values such as commands, version files, docs paths, deploy targets, locale, and intentional workflow deviations.
3. Add the missing custom agent entry point and optional hook files without overwriting local workflow customisations.
4. Replace older onboarding or update prompt files with the single consolidated application prompt.
5. If `Backup mode` requests backups, create them before editing.
6. Prefer a dedicated branch when the target repository is already under version control.
7. If `Preferred install/update branch in target repo` is provided, create or switch to that branch before editing when it can be done non-destructively.

### Existing repository with agent runtime

If `Target repository state` is `EXISTING_REPOSITORY_WITH_AGENT`:

1. Read the target repository's existing TCTBP runtime files first if they exist, including the local custom agent entry point, prompt, and optional hook files.
2. Preserve repo-specific values such as commands, version files, docs paths, deploy targets, locale, and intentional workflow deviations.
3. Merge forward generic improvements from the canonical repository instead of blindly overwriting local files.
4. Replace older onboarding or update prompt files with the single consolidated application prompt.
5. If `Backup mode` requests backups, create them before editing.
6. Prefer a dedicated branch when the target repository is already under version control.
7. If `Preferred install/update branch in target repo` is provided, create or switch to that branch before editing when it can be done non-destructively.

## What Must Be Customised In The Target Repository

Do not leave canonical-repo-specific values behind. Customise at least these categories:

- project name and description
- default branch name
- format, test, lint, build, and release-build commands
- version files and version source rules
- deploy target details and post-deploy checks
- docs and runbook review paths
- locale or writing conventions
- branch naming preferences if the target repo uses them

Update the custom agent description so it refers to the target repository rather than the canonical TCTBP repository.

When installing or refreshing prompts in the target repository, keep only the single consolidated application prompt instead of leaving multiple prompts that overlap in purpose.

## Hook Layer Rules

If `Include hook layer` is `YES`:

1. Install both `.github/hooks/tctbp-safety.json` and `scripts/tctbp-pretool-hook.js`.
2. Verify that the target environment has `node` or `nodejs` available on `PATH`, or clearly report that the hook is installed but not yet runnable.
3. Keep the hook narrow and auditable; do not broaden it unless explicitly asked.

If `Include hook layer` is `NO`:

1. Do not install the hook files.
2. Do not leave stale references to missing hook files in the target repository's docs or instructions.

## Required Behaviour

1. Read the canonical TCTBP files from the current repository.
2. Read the current local versions of every managed target file before editing when they exist.
3. Inspect the target repository structure, commands, version files, deployment scripts, and documentation paths before editing.
4. Classify what you find before making edits:
   - generic canonical improvements to merge forward
   - repo-specific local settings to preserve exactly
   - conflicts or intentional deviations that require judgement
5. Determine whether the target repo is a new install, an install of missing agent runtime, or an update of existing agent runtime.
6. If the target repository is already under git and a preferred install/update branch was provided, create or switch to that branch before editing when safe.
7. Create the required files and folders in the target repo.
8. Preserve repo-specific settings while applying the canonical runtime model.
9. Keep these target files aligned with each other after editing:
   - `.gitignore`
   - `.github/agents/TCTBP.agent.md`
   - `.github/TCTBP.json`
   - `.github/TCTBP Agent.md`
   - `.github/TCTBP Cheatsheet.md`
   - `.github/copilot-instructions.md`
   - `.github/prompts/Install TCTBP Agent Infrastructure Into Another Repository.prompt.md`
10. Ensure `.gitignore` ignores `.github/.tctbp-backups/` so local file backups created by reconcile work do not get committed as normal workflow changes.
11. If backup artefacts under `.github/.tctbp-backups/` are already tracked in the target repository, remove them from version control non-destructively while preserving the local backup files.
12. If the hook layer is included, keep `.github/hooks/tctbp-safety.json` and `scripts/tctbp-pretool-hook.js` aligned with the installed documentation.
13. Validate the edited files using available JSON and Markdown diagnostics and any lightweight repo validation that fits the change type.
14. Run a post-install smoke check for the installed runtime surface:
   - confirm `.github/agents/TCTBP.agent.md` frontmatter is valid and its description still contains the explicit trigger phrases
   - confirm prompt frontmatter is valid and references the installed runtime files consistently
   - confirm `.github/hooks/tctbp-safety.json` points at the installed hook script path when the hook layer is enabled
   - confirm no docs or instructions still reference omitted hook files when the hook layer is disabled
15. Do not perform checkpoint, SHIP, publish, deploy, or handover in the target repo unless explicitly requested.

## What You Must Not Do

Do not:

- leave references instructing the target repo to depend on this canonical repo at runtime
- copy repo-specific commands or paths from the canonical repo into the target repo without adaptation
- overwrite existing target-repo workflow files wholesale without review
- guess unknown commands, version files, deploy steps, or docs paths
- install the hook layer without also installing its supporting script
- use stash, reset, rebase, force-push, or destructive checkout as part of the setup

## Preferred Final Summary

When finished, report:

1. which canonical ref from this repository was used
2. which target repository path was updated
3. which files were created or updated in the target repo
4. which repo-specific values were intentionally customised or preserved
5. which target-repository state was detected or applied
6. whether the hook layer was installed and whether `node` or `nodejs` was available
7. any unresolved values or follow-up checks

## Example Invocation

```text
reconcile-tctbp <ABSOLUTE_TARGET_REPO_PATH>

Canonical TCTBP repository path: <ABSOLUTE_CANONICAL_TCTBP_REPO_PATH_OR_CURRENT_REPO>
Target repository path: <ABSOLUTE_TARGET_REPO_PATH>
Target repository state: AUTO
Preferred install/update branch in target repo: chore/apply-tctbp
Include hook layer: YES
Backup mode for existing repo: BRANCH_AND_FILE_BACKUPS
Canonical ref to use from this TCTBP repo: main
Any repo-specific settings that must be preserved exactly: build commands, deploy target names, docs paths
Any intentional local workflow deviations that must not be normalised away: none known
```