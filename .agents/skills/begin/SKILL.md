---
name: begin
description: Begin a repository session using its declared shared TCTBP mode and verified continuation.
---

# Begin

Read the selected repository's `AGENTS.md` and applicable TCTBP policy. Run
`node scripts/tctbp-run-begin.cjs --json` from that checkout. This is the same
contract used by DSH `/begin`; the project profile owns its permitted mode.

Use `--no-actions` for read-only/no-action requests and `--preview` for a plan.
Both use cached refs without fetch, resume, live peer calls or data workflows.
`--no-sync` skips the declared data adapter; skipped required data remains an
incomplete handoff. Unknown flags stop the command. Missing runtime/profile or
an unsupported checkout permits local inspection only; never fall back to an
older composite resume or generic ticket pull.

Read every result and the actual returned continuation content. Report the
selected checkout, branch, full commit, freshness and separate Git/peer/data
outcomes. A cached, skipped, local-only or unverified result is not READY.
Preserve dirty work, unfinished Git operations and divergence. Do not checkpoint,
stash, reset, rebase, publish, or move another worktree's branch as part of Begin.

A proposed branch switch needs explicit approval of its named branch and both
full preview commit IDs. Only then repeat Begin with `--switch-to`,
`--expected-head`, `--expected-target` and the returned `--expected-context`. An environment variable or ordinary
Begin request grants no branch-switch approval.

A peer saved-work handover is a separate approval. Show its fresh exact preview,
source/destination branches and commits, paths/exclusions, remotes and recovery
copies. Only after the user approves that preview may you use
`--recover <preview-id>`. Unknown peers require an explicit
`--continue-published <preview-id>` decision and remain unverified. Never use it
to bypass known unfinished work. Changed evidence or controller/release/profile
expires approval. Retain partial receipts; do not retry blindly. An exact
recovery target with `skipResume` bypasses normal branch selection.

Data actions are limited to the project's declared adapter after fresh pinned
Git READY. A project without a data service gets no generic ticket/settings call.
A guarded data adapter requires its committed incoming manifest, verified runtime
bindings and final native data/Git proofs. Missing evidence is BLOCKED; never
invent a manifest/baseline or clear a hold by inference.

Brief the user on current work, verified state, gotchas and a recommended first
action. Reading the continuation does not authorise executing that next action.
