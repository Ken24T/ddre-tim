#!/usr/bin/env node

const {
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
  const branchPolicy = config.branch || {};
  const branchModel = resolveBranchModel(config);
  const defaultBranch =
    branchPolicy.defaultBranch
    || branchModel.workingBranch
    || (config.project && config.project.defaultBranch)
    || "development";
  const sourceBranch = getCurrentBranch();

  if (sourceBranch === "HEAD") {
    fail("Branch workflow stopped because HEAD is detached.");
  }

  if (!cliOptions.targetBranch && branchPolicy.allowCloseoutWithoutNewBranch === false) {
    fail("Branch workflow requires a target branch name in this policy.");
  }

  if (cliOptions.targetBranch) {
    validateTargetBranchName(cliOptions.targetBranch);

    if (branchPolicy.stopIfTargetBranchEqualsDefault !== false && cliOptions.targetBranch === defaultBranch) {
      fail(`Branch workflow stopped because target '${cliOptions.targetBranch}' matches default branch '${defaultBranch}'.`);
    }

    if (branchPolicy.stopIfTargetBranchExistsLocal !== false && gitLocalBranchExists(cliOptions.targetBranch)) {
      fail(`Branch workflow stopped because target branch '${cliOptions.targetBranch}' already exists locally.`);
    }

    if (branchPolicy.stopIfTargetBranchExistsRemote !== false && gitRemoteBranchExists(cliOptions.targetBranch)) {
      fail(`Branch workflow stopped because target branch '${cliOptions.targetBranch}' already exists on origin.`);
    }
  }

  const workingTreeSummary = summariseWorkingTree(getWorkingTreeStatus());
  if (branchPolicy.requiresCleanTreeBeforeSwitch !== false && !workingTreeSummary.isClean) {
    fail("Branch workflow stopped because working tree is dirty. Commit/checkpoint first.");
  }

  logSection("Branch");
  logItem("Mode", cliOptions.dryRun ? "dry-run" : "live");
  logItem("Source", sourceBranch);
  logItem("Default", defaultBranch);
  logItem("Target", cliOptions.targetBranch || "(closeout only)");

  fetchOrigin(cliOptions.dryRun, false);

  const sourceRemoteExists = gitRemoteBranchExists(sourceBranch);
  if (branchPolicy.requireSourceBranchPublishedBeforeTransition === true && !sourceRemoteExists) {
    fail(`Branch workflow stopped because source '${sourceBranch}' is not published to origin.`);
  }

  const sourceSync = sourceRemoteExists
    ? inspectBranchSyncState(sourceBranch, { remoteExists: true, localRef: "HEAD" })
    : { ahead: 0, behind: 0, diverged: false };

  if (branchPolicy.stopIfSourceBranchDiverged !== false && sourceSync.diverged) {
    fail(`Branch workflow stopped because '${sourceBranch}' diverged from origin/${sourceBranch}.`);
  }

  if (branchPolicy.stopIfSourceBranchBehindUpstream !== false && sourceSync.behind > 0) {
    fail(`Branch workflow stopped because '${sourceBranch}' is behind origin/${sourceBranch} by ${sourceSync.behind} commit(s).`);
  }

  if (!gitLocalBranchExists(defaultBranch)) {
    const defaultRemoteExists = gitRemoteBranchExists(defaultBranch);
    if (!defaultRemoteExists) {
      fail(`Branch workflow stopped because default branch '${defaultBranch}' does not exist locally or on origin.`);
    }

    runMutableGit(
      ["switch", "-c", defaultBranch, "--track", `origin/${defaultBranch}`],
      cliOptions.dryRun,
      `Create local ${defaultBranch} from origin/${defaultBranch}`
    );
  } else if (sourceBranch !== defaultBranch) {
    runMutableGit(["switch", defaultBranch], cliOptions.dryRun, `Switch to ${defaultBranch}`);
  }

  if (sourceBranch !== defaultBranch && branchPolicy.mergeSourceIntoDefaultWhenSourceIsNotDefault !== false) {
    runMutableGit(
      ["merge", "--no-ff", "--no-edit", sourceBranch],
      cliOptions.dryRun,
      `Merge ${sourceBranch} into ${defaultBranch}`
    );
  }

  if (cliOptions.targetBranch) {
    runMutableGit(["switch", "-c", cliOptions.targetBranch], cliOptions.dryRun, `Create and switch to ${cliOptions.targetBranch}`);
  }

  const sourceLocalSha = getShortRef(`refs/heads/${sourceBranch}`) || "n/a";
  const sourceOriginSha = sourceRemoteExists ? getShortRef(`refs/remotes/origin/${sourceBranch}`) || "n/a" : "n/a";
  const defaultLocalSha = getShortRef(`refs/heads/${defaultBranch}`) || "n/a";
  const activeBranch = cliOptions.dryRun
    ? (cliOptions.targetBranch || defaultBranch)
    : getCurrentBranch();

  printSummaryTable([
    {
      origin: sourceRemoteExists ? `origin/${sourceBranch} @ ${sourceOriginSha}` : "n/a",
      local: `${sourceBranch} @ ${sourceLocalSha}`,
      status: `Source sync: ${formatSyncStatus(sourceSync, sourceRemoteExists)}`,
      actions: sourceRemoteExists ? "Source branch is eligible for closeout." : "Source branch has no remote.",
    },
    {
      origin: "n/a",
      local: `${defaultBranch} @ ${defaultLocalSha}`,
      status: sourceBranch === defaultBranch ? "Already on default branch" : `Closeout target: ${defaultBranch}`,
      actions:
        sourceBranch === defaultBranch
          ? "No merge needed."
          : cliOptions.dryRun
            ? `Would merge ${sourceBranch} into ${defaultBranch}.`
            : `Merged ${sourceBranch} into ${defaultBranch}.`,
    },
    {
      origin: "n/a",
      local: activeBranch,
      status: "Active branch after workflow",
      actions: cliOptions.targetBranch
        ? (cliOptions.dryRun ? `Would create and switch to ${cliOptions.targetBranch}.` : `Switched to ${cliOptions.targetBranch}.`)
        : `Closeout complete on ${defaultBranch}.`,
    },
  ]);

  console.log(`Branch ${cliOptions.dryRun ? "plan" : "workflow"} complete.`);
}

function validateTargetBranchName(value) {
  const branchName = String(value || "").trim();

  if (!branchName) {
    fail("Target branch name cannot be empty.");
  }

  const isValid = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branchName)
    && !branchName.includes("..")
    && !branchName.endsWith("/")
    && !branchName.endsWith(".")
    && !branchName.includes("//")
    && !branchName.includes("@{")
    && branchName !== "HEAD";

  if (!isValid) {
    fail(`Invalid target branch name '${value}'.`);
  }
}

function parseArgs(argv) {
  const parsed = {
    targetBranch: null,
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

    if (arg.startsWith("--")) {
      fail(`Unknown option '${arg}'.`);
    }

    if (parsed.targetBranch) {
      fail(`Unexpected extra argument '${arg}'.`);
    }

    parsed.targetBranch = arg;
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-branch.js [new-branch-name] [--dry-run] [--list]");
  process.exit(exitCode);
}
