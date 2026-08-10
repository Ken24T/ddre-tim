---
description: "Use when the user explicitly asks for scaffold, scaffold please, scaffold web, scaffold web please, new project, or create project to create a new web project with the full TCTBP-Web runtime surface pre-installed and configured."
name: "scaffold-tctbp-web"
argument-hint: "Absolute target directory path, plus optional project name, working branch, branch strategy, deploy target, and test framework"
agent: "agent"
---

# Scaffold New TCTBP-Web Project

Use this prompt inside a TCTBP-Web repository when you want Copilot to handle an explicit `scaffold`, `scaffold web`, `new project`, or `create project` request and create a fully-instrumented new web project from scratch.

## Goal

Create a new web project directory with the complete TCTBP-Web runtime surface pre-installed, a populated profile configured from the scaffold interview answers, a working git repository with the branch structure in place, and unit test scaffolding ready to run.

The generated project opens on the working branch, ready for `npm install` and development.

## Interview Questions

Ask the user these questions, in order. Each has a sensible default:

1. **Project name** (required) — must be a valid npm package name: lowercase, hyphens allowed, no spaces.
2. **Target directory path** (required) — absolute path. Must not exist, or must be an empty directory.
3. **Working branch name** — default: `development`
4. **Branch strategy** — `staged` (development → staging → main) or `simple` (main only). Default: `staged`.
5. **Deploy target** — `Vercel`, `Netlify`, `Cloudflare Pages`, `Docker`, or `none yet`. Default: `none yet`.
6. **Test framework** — `vitest`, `jest`, or `none`. Default: `vitest`.

All questions can be skipped with `--defaults` to use the defaults for a rapid scaffold.

## Execution

Run the scaffold runner:

```
node scripts/tctbp-run-scaffold.js --name "<name>" --target "<path>" --working "<branch>" --strategy <staged|simple> --deploy "<target>" --test <vitest|jest|none>
```

Or for a dry run:

```
node scripts/tctbp-run-scaffold.js --name "<name>" --target "<path>" --dry-run
```

Or with all defaults:

```
node scripts/tctbp-run-scaffold.js --defaults --target "<path>" --name "<name>"
```

## What Gets Created

1. **Project skeleton:** `package.json`, `tsconfig.json`, `.gitignore`, `README.md`
2. **TCTBP-Web runtime:** 19 runner scripts in `scripts/`, agent files in `.github/`, hook config
3. **Populated profile:** `.github/TCTBP.json` with all answers applied
4. **Git repository:** `git init`, initial commit, branch structure created
5. **Test scaffolding:** Vitest or Jest config + placeholder test (if selected)
6. **Branch structure:** `main`, `staging` (if staged), working branch (checked out)
7. **Smoke test:** Status runner and gate runner verified to work

## What The Generated Project Can Do Immediately

- `node scripts/tctbp-run-status.js` — repo state snapshot
- `node scripts/tctbp-run-checkpoint.js` — local work preservation
- `node scripts/tctbp-run-gate.js test` — test gate (if test framework selected)
- `git checkout development` — start coding on the working branch

## After Scaffold

Tell the user:

1. `cd <target-path>`
2. `npm install`
3. Add their framework (Vite, Next.js, etc.)
4. Update `.github/TCTBP.json` commands when they add scripts
5. `git checkout <working-branch>` (should already be there)

## Constraints

- The target directory must not exist, or must be empty.
- The scaffold runner never modifies the current TCTBP-Web repository.
- All generated files are self-contained; the new project does not depend on TCTBP-Web at runtime.
- Runners work immediately after scaffold, before `npm install` or any framework is added.
