#!/usr/bin/env node

/**
 * TCTBP Abort Runner
 *
 * Inspect and recover from partial local git operation state.
 *
 * Defaults to preview mode (inspect + propose only). Use --apply to execute
 * safe local abort commands for in-progress git operations.
 *
 * Safety guarantees:
 *   - Never force-pushes or rewrites history.
 *   - Never runs reset/rebase rewrite steps.
 *   - Only executes git *--abort operations when explicitly approved via --apply.
 */

const {
  detectGitOperationState,
  fail,
  fetchOrigin,
  formatSyncStatus,
  getCurrentBranch,
  getHeadSummary,
  getReachableReleaseTag,
  getShortRef,
  getTagsPointingAtHead,
  getWorkingTreeStatus,
  gitRemoteBranchExists,
  gitRemoteTagExists,
  inspectBranchSyncState,
  loadPolicy,
  logItem,
  logSection,
  printSummaryTable,
  readVersionSource,
  runMutableGit,
  summariseWorkingTree,
} = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printUsage(0);
}

main(loadPolicy(), options);

function main(config, cliOptions) {
  if (cliOptions.apply && cliOptions.dryRun) {
    fail("Abort options conflict: choose either --apply or --dry-run, not both.");
  }

  logSection("Abort");
  logItem("Mode", cliOptions.apply ? "apply" : cliOptions.dryRun ? "dry-run" : "preview");

  const currentBranch = getCurrentBranch();
  const headSummary = getHeadSummary();
  const operationStates = detectGitOperationState();
  const workingTreeSummary = summariseWorkingTree(getWorkingTreeStatus());

  if (!cliOptions.dryRun) {
    fetchOrigin(false, true);
  }

  const currentRemoteExists = currentBranch === "HEAD" ? false : gitRemoteBranchExists(currentBranch);
  const currentSyncState =
    currentBranch === "HEAD"
      ? {
          ahead: 0,
          behind: 0,
          diverged: false,
        }
      : inspectBranchSyncState(currentBranch, { remoteExists: currentRemoteExists, localRef: "HEAD" });
  const currentLocalSha = getShortRef("HEAD");
  const currentOriginSha = currentRemoteExists ? getShortRef(`refs/remotes/origin/${currentBranch}`) : null;

  const versionInfo = readVersionSource(config);
  const headTags = getTagsPointingAtHead(config);
  const expectedHeadTag = buildExpectedTag(config, versionInfo.version);
  const unpublishedHeadTags = headTags.filter((tag) => !gitRemoteTagExists(tag));
  const hasTagVersionMismatch = Boolean(expectedHeadTag && headTags.length > 0 && !headTags.includes(expectedHeadTag));
  const lastReachableTag = getReachableReleaseTag(config) || "none";

  const rows = [
    {
      origin: currentRemoteExists ? `${currentBranch} @ ${currentOriginSha}` : "n/a",
      local: `${currentBranch} @ ${currentLocalSha}`,
      status: formatSyncStatus(currentSyncState, currentRemoteExists),
      actions:
        currentBranch === "HEAD"
          ? "Check out a branch before running sync workflows."
          : currentSyncState.diverged
            ? "After abort, run resume guidance before mutating workflows."
            : "None.",
    },
    {
      origin: "n/a",
      local: operationStates.length > 0 ? operationStates.join(", ") : "none",
      status: operationStates.length > 0 ? "Partial git operation detected" : "No in-progress operation",
      actions: operationStates.length > 0 ? "Run with --apply to execute approved local abort actions." : "None.",
    },
    {
      origin: "n/a",
      local: workingTreeSummary.summary,
      status: workingTreeSummary.isClean ? "Clean" : "Dirty",
      actions: workingTreeSummary.isClean ? "None." : "Preserve uncommitted work with checkpoint if needed.",
    },
    {
      origin: unpublishedHeadTags.length > 0 ? unpublishedHeadTags.join(", ") : "none",
      local: headTags.length > 0 ? headTags.join(", ") : "none",
      status: unpublishedHeadTags.length > 0 ? "Local release tag not published" : "No unpublished head release tags",
      actions:
        unpublishedHeadTags.length > 0
          ? "Decide to publish tag or delete local tag manually after recovery."
          : "None.",
    },
    {
      origin: "n/a",
      local: `${versionInfo.path}: ${versionInfo.version} (reachable tag: ${lastReachableTag})`,
      status: hasTagVersionMismatch ? "Version/tag mismatch detected" : "Version/tag alignment looks consistent",
      actions:
        hasTagVersionMismatch
          ? "Review ship state before any release action; do not rewrite history automatically."
          : "None.",
    },
    {
      origin: "n/a",
      local: headSummary,
      status: "HEAD summary",
      actions: "Reference for manual recovery decisions.",
    },
  ];

  printSummaryTable(rows);

  const recoveryActions = buildRecoveryActions(operationStates);
  printProposedRecovery(recoveryActions, unpublishedHeadTags, hasTagVersionMismatch, expectedHeadTag, headTags);

  if (!cliOptions.apply) {
    console.log("\nPreview only. Re-run with --apply to execute the proposed local abort actions.");
    return;
  }

  if (recoveryActions.length === 0) {
    console.log("\nNo executable abort action is required right now.");
    return;
  }

  for (const action of recoveryActions) {
    runMutableGit(action.args, false, action.label);
  }

  console.log(`\nExecuted ${recoveryActions.length} recovery action(s).`);
  console.log("Abort workflow complete. Review status before running other mutating workflows.");
}

function buildExpectedTag(config, version) {
  if (!version || version === "n/a" || version === "unknown") {
    return null;
  }

  const format =
    config && config.profile && config.profile.versioning && typeof config.profile.versioning.tagFormat === "string"
      ? config.profile.versioning.tagFormat
      : "v{version}";

  return format.includes("{version}") ? format.replace("{version}", version) : null;
}

function buildRecoveryActions(operationStates) {
  const actionMap = {
    merge: {
      args: ["merge", "--abort"],
      label: "Abort in-progress merge",
      consequence: "Restores pre-merge index/worktree where possible and clears MERGE_HEAD.",
    },
    rebase: {
      args: ["rebase", "--abort"],
      label: "Abort in-progress rebase",
      consequence: "Returns branch to pre-rebase commit and clears rebase state.",
    },
    "cherry-pick": {
      args: ["cherry-pick", "--abort"],
      label: "Abort in-progress cherry-pick",
      consequence: "Cancels cherry-pick sequence and restores pre-sequence state.",
    },
    revert: {
      args: ["revert", "--abort"],
      label: "Abort in-progress revert",
      consequence: "Cancels revert sequence and restores pre-sequence state.",
    },
  };

  return operationStates
    .filter((state) => Boolean(actionMap[state]))
    .map((state) => ({
      kind: state,
      ...actionMap[state],
    }));
}

function printProposedRecovery(recoveryActions, unpublishedHeadTags, hasTagVersionMismatch, expectedHeadTag, headTags) {
  console.log("Proposed recovery actions:");

  if (recoveryActions.length === 0) {
    console.log("- No in-progress git operation was detected.");
  } else {
    for (const action of recoveryActions) {
      console.log(`- ${action.label}: git ${action.args.join(" ")}`);
      console.log(`  Consequence: ${action.consequence}`);
    }
  }

  if (unpublishedHeadTags.length > 0) {
    for (const tag of unpublishedHeadTags) {
      console.log(`- Review unpublished tag ${tag}: decide to push or delete manually after recovery.`);
    }
  }

  if (hasTagVersionMismatch) {
    console.log(
      `- Review version/tag mismatch: expected head tag ${expectedHeadTag || "unknown"}, found ${headTags.join(", ") || "none"}.`
    );
  }

  console.log("- No history rewrite or force push is performed by this runner.");
}

function parseArgs(argv) {
  const parsed = {
    apply: false,
    dryRun: false,
    list: false,
  };

  for (const arg of argv) {
    if (arg === "--apply") {
      parsed.apply = true;
      continue;
    }

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
  return "Usage: node scripts/tctbp-run-abort.js [--apply] [--dry-run] [--list]";
}

function printUsage(exitCode) {
  console.log(getUsageLine());
  process.exit(exitCode);
}