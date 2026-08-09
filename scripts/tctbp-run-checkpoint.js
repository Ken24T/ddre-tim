#!/usr/bin/env node

const {
  detectGitOperationState,
  fail,
  formatSyncStatus,
  getCurrentBranch,
  getHeadCommit,
  getShortRef,
  getWorkingTreeStatus,
  gitRemoteBranchExists,
  inspectBranchSyncState,
  loadPolicy,
  logItem,
  logSection,
  printDirtySummary,
  printSummaryTable,
  runMutableGit,
  summariseWorkingTree
} = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printUsage(0);
}

main(loadPolicy(), options);

function main(config, cliOptions) {
  const branch = getCurrentBranch();

  if (branch === "HEAD") {
    fail("Checkpoint stopped because HEAD is detached.");
  }

  const operationStates = detectGitOperationState();

  if (operationStates.length > 0) {
    fail(`Checkpoint stopped because a ${operationStates.join(", ")} workflow is already in progress.`);
  }

  const preflightStatusOutput = getWorkingTreeStatus();
  const workingTreeSummary = summariseWorkingTree(preflightStatusOutput);

  if (workingTreeSummary.isClean) {
    fail("Checkpoint stopped because the working tree is already clean.");
  }

  const previousHead = getHeadCommit(true);
  const remoteExists = gitRemoteBranchExists(branch);
  const originBefore = remoteExists ? getShortRef(`refs/remotes/origin/${branch}`) : null;
  const commitMessage = buildCheckpointMessage(config, cliOptions.message);

  logSection("Checkpoint");
  logItem("Branch", branch);
  logItem("Mode", cliOptions.dryRun ? "dry-run" : "live");
  logItem("Message", commitMessage);
  printDirtySummary(preflightStatusOutput, "Checkpoint preservation summary", "These paths will be staged into the checkpoint commit:");

  if (cliOptions.dryRun) {
    printSummaryTable([
      {
        origin: originBefore || "n/a",
        local: previousHead,
        status: "Previous HEAD commit",
        actions: "Dry run only; no checkpoint commit was created."
      },
      {
        origin: originBefore || "n/a",
        local: "planned checkpoint commit",
        status: "Checkpoint commit",
        actions: commitMessage
      },
      {
        origin: "n/a",
        local: "dirty working tree preserved in plan",
        status: "Working tree result",
        actions: "A live run would stage tracked and untracked files."
      },
      {
        origin: remoteExists ? `origin/${branch} @ ${originBefore}` : "n/a",
        local: `${branch} @ ${previousHead}`,
        status: `Upstream sync state: ${formatSyncStatus(inspectBranchSyncState(branch, { remoteExists, localRef: "HEAD" }), remoteExists)}`,
        actions: "No remote state would change."
      },
      {
        origin: originBefore || "n/a",
        local: previousHead,
        status: "Remote side effects",
        actions: "No push, tag, version bump, or deploy would occur."
      }
    ]);
    console.log("Dry run: no local commit or remote state was changed.");
    return;
  }

  runMutableGit(["add", "-A"], false, "Stage the checkpoint commit");
  runMutableGit(["commit", "-m", commitMessage], false, "Create the checkpoint commit");

  const checkpointCommit = getHeadCommit(true);
  const syncStateAfter = inspectBranchSyncState(branch, { remoteExists, localRef: "HEAD" });

  printSummaryTable([
    {
      origin: originBefore || "n/a",
      local: previousHead,
      status: "Previous HEAD commit",
      actions: "Baseline before checkpoint creation."
    },
    {
      origin: originBefore || "n/a",
      local: checkpointCommit,
      status: "Checkpoint commit",
      actions: "Local-only preservation commit created."
    },
    {
      origin: "n/a",
      local: "clean",
      status: "Working tree result",
      actions: "None."
    },
    {
      origin: remoteExists ? `origin/${branch} @ ${originBefore}` : "n/a",
      local: `${branch} @ ${checkpointCommit}`,
      status: `Upstream sync state: ${formatSyncStatus(syncStateAfter, remoteExists)}`,
      actions: remoteExists ? "Publish only if you want the checkpoint on origin." : "Branch remains local-only until you publish it."
    },
    {
      origin: originBefore || "n/a",
      local: checkpointCommit,
      status: "Remote side effects",
      actions: "No push, tag, version bump, or deploy occurred."
    }
  ]);

  console.log(`Checkpoint complete on ${branch} at ${checkpointCommit}.`);
}

function buildCheckpointMessage(config, overrideMessage) {
  if (typeof overrideMessage === "string" && overrideMessage.trim().length > 0) {
    return overrideMessage;
  }

  const checkpointConfig = config.checkpoint || {};
  return typeof checkpointConfig.defaultCommitMessage === "string" && checkpointConfig.defaultCommitMessage.trim().length > 0
    ? checkpointConfig.defaultCommitMessage
    : "checkpoint: preserve local working state";
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    list: false,
    message: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--list":
        parsed.list = true;
        break;
      case "--message": {
        const value = argv[index + 1];

        if (!value || value.startsWith("--")) {
          fail("--message requires a quoted commit message.");
        }

        parsed.message = value;
        index += 1;
        break;
      }
      default:
        fail(`Unknown option '${arg}'.`);
    }
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-checkpoint.js [--dry-run] [--message \"<message>\"] [--list]");
  process.exit(exitCode);
}