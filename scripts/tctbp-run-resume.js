#!/usr/bin/env node

/**
 * TCTBP Resume Runner
 *
 * Safely fast-forwards local branches that are behind their origin counterpart.
 *
 * Safety guarantees:
 *   - Never touches a diverged branch (local has commits origin does not).
 *   - Never force-pushes or rewrites history.
 *   - Never switches away from the current branch.
 *   - Refuses to run while a merge, rebase, cherry-pick, or revert is in progress.
 *   - Refuses to run when the working tree is dirty (uncommitted local changes
 *     could be lost or conflicted by a fast-forward on the current branch).
 *   - In dry-run mode, inspects all state but executes no git mutations.
 *
 * Usage:
 *   node scripts/tctbp-run-resume.js [--dry-run] [--list]
 */

const {
  detectGitOperationState,
  fail,
  fetchOrigin,
  formatSyncStatus,
  getCurrentBranch,
  getShortRef,
  getWorkingTreeStatus,
  gitLocalBranchExists,
  gitRemoteBranchExists,
  inspectBranchSyncState,
  loadPolicy,
  logItem,
  logSection,
  printSummaryTable,
  resolveBranchModel,
  runMutableGit,
  summariseWorkingTree,
} = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printUsage(0);
}

main(loadPolicy(), options);

function main(config, cliOptions) {
  // ── Preflight ──────────────────────────────────────────────────────────────

  const currentBranch = getCurrentBranch();

  if (currentBranch === "HEAD") {
    fail("Resume stopped because HEAD is detached. Check out a branch before resuming.");
  }

  const operationStates = detectGitOperationState();
  if (operationStates.length > 0) {
    fail(
      `Resume stopped because a ${operationStates.join(", ")} operation is in progress. ` +
      "Resolve or abort the in-progress operation before resuming."
    );
  }

  const workingTreeSummary = summariseWorkingTree(getWorkingTreeStatus());
  if (!workingTreeSummary.isClean) {
    fail(
      "Resume stopped because the working tree has uncommitted changes. " +
      "Run 'checkpoint' first to preserve your work, then resume."
    );
  }

  logSection("Resume");
  logItem("Mode", cliOptions.dryRun ? "dry-run" : "live");
  logItem("Current branch", currentBranch);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  fetchOrigin(cliOptions.dryRun, true);

  // ── Determine which branches to inspect ───────────────────────────────────

  const branchModel = resolveBranchModel(config);
  const candidates = Array.from(
    new Set([...branchModel.significantBranches, currentBranch])
  );

  // ── Evaluate and action each branch ───────────────────────────────────────

  const rows = [];
  let fastForwardCount = 0;
  let skippedCount = 0;
  let alreadySyncedCount = 0;
  let localMissingCount = 0;

  for (const branchName of candidates) {
    const localExists = gitLocalBranchExists(branchName);
    const remoteExists = gitRemoteBranchExists(branchName);

    if (!remoteExists) {
      // No origin counterpart — nothing to sync, not an error.
      rows.push({
        origin: "n/a",
        local: localExists ? branchName : "n/a",
        status: `${branchName}: no remote`,
        actions: "Skipped — branch has no origin counterpart.",
      });
      continue;
    }

    const originSha = getShortRef(`refs/remotes/origin/${branchName}`);

    if (!localExists) {
      localMissingCount++;
      rows.push({
        origin: `origin/${branchName} @ ${originSha}`,
        local: "missing locally",
        status: `${branchName}: missing locally`,
        actions: "Not created — use 'git checkout -b " + branchName + " origin/" + branchName + "' to create it.",
      });
      continue;
    }

    const localSha = getShortRef(`refs/heads/${branchName}`);
    const syncState = inspectBranchSyncState(branchName, { remoteExists: true });

    if (syncState.diverged) {
      // SAFETY: never touch a diverged branch.
      skippedCount++;
      console.log(`\u26A0\uFE0F  WARNING: '${branchName}' has DIVERGED from origin/${branchName} and was NOT updated.`);
      console.log(`   Local and remote have independent commits. Manual intervention required.`);
      console.log(`   Inspect: git log --oneline --graph ${branchName}...origin/${branchName}`);
      rows.push({
        origin: `origin/${branchName} @ ${originSha}`,
        local: `${branchName} @ ${localSha}`,
        status: `${branchName}: DIVERGED — skipped`,
        actions:
          "Manual intervention required. Local and remote have independent commits. " +
          "Do not fast-forward a diverged branch.",
      });
      continue;
    }

    if (syncState.behind === 0) {
      alreadySyncedCount++;
      rows.push({
        origin: `origin/${branchName} @ ${originSha}`,
        local: `${branchName} @ ${localSha}`,
        status: `${branchName}: ${formatSyncStatus(syncState, true)}`,
        actions: "Already in sync — no action taken.",
      });
      continue;
    }

    // Branch is purely behind (not diverged) — safe to fast-forward.
    const isCurrentBranch = branchName === currentBranch;

    if (isCurrentBranch) {
      // Fast-forward the current branch via git merge --ff-only (stays checked out).
      runMutableGit(
        ["merge", "--ff-only", `origin/${branchName}`],
        cliOptions.dryRun,
        `Fast-forward current branch ${branchName}`
      );
    } else {
      // Fast-forward a non-checked-out branch directly via fetch refspec.
      // This does NOT switch branches, so no working-tree risk.
      runMutableGit(
        ["fetch", "origin", `refs/heads/${branchName}:refs/heads/${branchName}`],
        cliOptions.dryRun,
        `Fast-forward ${branchName} without switching`
      );
    }

    fastForwardCount++;
    const localShaAfter = cliOptions.dryRun ? `${localSha} → ${originSha} (planned)` : getShortRef(`refs/heads/${branchName}`);
    rows.push({
      origin: `origin/${branchName} @ ${originSha}`,
      local: `${branchName} @ ${localShaAfter}`,
      status: `${branchName}: fast-forwarded (was behind by ${syncState.behind})`,
      actions: cliOptions.dryRun ? "Dry run — no changes applied." : "Fast-forward complete.",
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  printSummaryTable(rows);

  const parts = [];
  if (fastForwardCount > 0) parts.push(`${fastForwardCount} fast-forwarded`);
  if (alreadySyncedCount > 0) parts.push(`${alreadySyncedCount} already in sync`);
  if (skippedCount > 0) parts.push(`${skippedCount} diverged (skipped — manual action needed)`);
  if (localMissingCount > 0) parts.push(`${localMissingCount} missing locally (not created)`);

  console.log(`Resume ${cliOptions.dryRun ? "plan" : "workflow"} complete. ${parts.join(", ")}.`);

  if (skippedCount > 0) {
    console.log(
      "\nWARNING: One or more diverged branches were skipped. " +
      "A diverged branch means local commits exist that origin does not have, or vice versa. " +
      "Resolve manually — do not force-reset."
    );
  }

  // ── Post-resume status report ────────────────────────────────────────────

  if (!cliOptions.dryRun) {
    const { spawnSync } = require("child_process");
    const path = require("path");
    const fs = require("fs");

    // ── Continuation prompt detection ───────────────────────────────────

    const continuationDir = path.resolve(
      process.cwd(),
      ".tctbp",
      "continuation"
    );

    let continuationFiles = [];
    try {
      continuationFiles = fs
        .readdirSync(continuationDir)
        .filter((name) => name.endsWith(".md"))
        .sort();
    } catch {
      // Directory does not exist or is not readable — skip.
    }

    if (continuationFiles.length > 0) {
      const newest = continuationFiles[continuationFiles.length - 1];
      const promptPath = path.join(".tctbp", "continuation", newest);

      // Extract the branch name from the prompt file if possible
      let branchNote = "";
      try {
        const content = fs.readFileSync(
          path.join(continuationDir, newest),
          "utf8"
        );
        const branchMatch = content.match(
          /^[#*]+\s*Branch\s*[&:]?\s*Commit\s*Context\s*$[\s\S]*?\*\*Branch:\*\*\s*(\S+)/im
        );
        if (branchMatch && branchMatch[1]) {
          const promptBranch = branchMatch[1].trim();
          if (promptBranch !== currentBranch) {
            branchNote =
              "\nNOTE: That handover was from branch \"" +
              promptBranch +
              "\" — you are currently on \"" +
              currentBranch +
              "\".\n" +
              "The continuation context may not match your current branch.";
          }
        }
      } catch {
        // Could not read or parse — skip.
      }

      console.log(
        `\n${"=".repeat(60)}`
      );
      console.log(
        "Handover continuation prompt found: " + promptPath
      );
      console.log(
        'Say "orient" or "pick up from handover" to bring Copilot up to speed.'
      );
      if (branchNote) {
        console.log(branchNote);
      }
      console.log(
        `${"=".repeat(60)}`
      );

      if (continuationFiles.length > 1) {
        console.log(
          `(${continuationFiles.length} continuation files total — only the newest is shown.)`
        );
      }
    }

    // ── Status report ──────────────────────────────────────────────────

    const statusScript = path.resolve(__dirname, "tctbp-run-status.js");

    const result = spawnSync(process.execPath, [statusScript], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    if (result.error) {
      console.error("Status report failed:", result.error.message);
    } else if (result.status !== 0) {
      console.error(`Status report exited with code ${result.status}.`);
    }
  }
}

// ── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    list: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    fail(`Unknown option '${arg}'. ${getUsageLine()}`);
  }

  return parsed;
}

function getUsageLine() {
  return "Usage: node scripts/tctbp-run-resume.js [--dry-run] [--list]";
}

function printUsage(exitCode) {
  console.log(getUsageLine());
  process.exit(exitCode);
}
