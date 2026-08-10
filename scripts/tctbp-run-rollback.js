#!/usr/bin/env node

const {
  detectGitOperationState,
  fail,
  getCurrentBranch,
  getHeadSummary,
  getWorkingTreeStatus,
  loadPolicy,
  logItem,
  logSection,
  printSummaryTable,
  runGitCapture,
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
    fail("Rollback options conflict: choose either --apply or --dry-run, not both.");
  }

  const branch = getCurrentBranch();
  if (branch === "HEAD") {
    fail("Rollback stopped because HEAD is detached.");
  }

  const operationStates = detectGitOperationState();
  if (operationStates.length > 0) {
    fail(`Rollback stopped because a ${operationStates.join(", ")} operation is already in progress.`);
  }

  const workingTreeSummary = summariseWorkingTree(getWorkingTreeStatus());
  if (!workingTreeSummary.isClean) {
    fail("Rollback stopped because working tree is dirty. Commit/checkpoint/stash your changes first.");
  }

  const checkpointPrefix =
    config && config.checkpoint && typeof config.checkpoint.commitMessagePrefix === "string"
      ? config.checkpoint.commitMessagePrefix
      : "checkpoint:";
  const checkpointCommit = getLatestCheckpointCommit(checkpointPrefix);

  if (!checkpointCommit) {
    fail(`Rollback stopped because no checkpoint commit was found (prefix '${checkpointPrefix}').`);
  }

  logSection("Rollback");
  logItem("Mode", cliOptions.apply ? "apply" : cliOptions.dryRun ? "dry-run" : "preview");
  logItem("Branch", branch);
  logItem("Checkpoint", `${checkpointCommit.shortSha} ${checkpointCommit.subject}`);

  printSummaryTable([
    {
      origin: "n/a",
      local: getHeadSummary(),
      status: "Current HEAD",
      actions: "Baseline before rollback.",
    },
    {
      origin: "n/a",
      local: `${checkpointCommit.shortSha} ${checkpointCommit.subject}`,
      status: "Latest checkpoint commit",
      actions: "Candidate to revert.",
    },
    {
      origin: "n/a",
      local: `git revert --no-edit ${checkpointCommit.sha}`,
      status: "Planned action",
      actions: cliOptions.apply ? "Executing revert now." : "Preview only; run with --apply to execute.",
    },
  ]);

  if (!cliOptions.apply) {
    console.log("Rollback preview complete. No history was changed.");
    return;
  }

  runMutableGit(["revert", "--no-edit", checkpointCommit.sha], false, `Revert checkpoint commit ${checkpointCommit.shortSha}`);
  console.log("Rollback complete. Checkpoint commit has been reverted with history preserved.");
}

function getLatestCheckpointCommit(prefix) {
  const history = runGitCapture(["log", "--format=%H%x09%h%x09%s", "-n", "300"], "Inspect recent commit history", true);
  const lines = history
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }

    const [sha, shortSha, subject] = parts;
    if (subject.toLowerCase().startsWith(String(prefix).toLowerCase())) {
      return { sha, shortSha, subject };
    }
  }

  return null;
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

    fail(`Unknown option '${arg}'.`);
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-rollback.js [--apply] [--dry-run] [--list]");
  process.exit(exitCode);
}
