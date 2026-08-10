#!/usr/bin/env node

const {
  fail,
  fetchOrigin,
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
    fail("Publish stopped because HEAD is detached.");
  }

  const workingTreeSummary = summariseWorkingTree(getWorkingTreeStatus());

  if (!workingTreeSummary.isClean) {
    fail("Publish stopped because the working tree is dirty.");
  }

  logSection("Publish");
  logItem("Branch", branch);
  logItem("Mode", cliOptions.dryRun ? "dry-run" : "live");

  fetchOrigin(cliOptions.dryRun, true);

  const remoteExistsBefore = gitRemoteBranchExists(branch);
  const originBefore = remoteExistsBefore ? getShortRef(`refs/remotes/origin/${branch}`) : null;
  const localHead = getHeadCommit(true);
  const syncStateBefore = inspectBranchSyncState(branch, { remoteExists: remoteExistsBefore, localRef: "HEAD" });

  if (syncStateBefore.diverged) {
    fail(`Publish stopped because ${branch} has diverged from origin/${branch}.`);
  }

  if (syncStateBefore.behind > 0) {
    fail(`Publish stopped because ${branch} is behind origin/${branch} by ${syncStateBefore.behind} commit(s).`);
  }

  let pushOccurred = false;

  if (!remoteExistsBefore) {
    if (config.publish && config.publish.createUpstreamOnFirstPublish === false) {
      fail(`Publish policy does not allow first publication of ${branch}.`);
    }

    runMutableGit(["push", "-u", "origin", branch], cliOptions.dryRun, `Publish ${branch} to origin/${branch}`);
    pushOccurred = true;
  } else if (syncStateBefore.ahead > 0) {
    runMutableGit(["push", "origin", branch], cliOptions.dryRun, `Push ${branch} to origin/${branch}`);
    pushOccurred = true;
  } else {
    console.log(`origin/${branch} is already up to date; no push is needed.`);
  }

  const remoteExistsAfter = cliOptions.dryRun ? remoteExistsBefore : gitRemoteBranchExists(branch);
  const originAfter = remoteExistsAfter ? getShortRef(`refs/remotes/origin/${branch}`) : originBefore;
  const syncStateAfter = cliOptions.dryRun
    ? syncStateBefore
    : inspectBranchSyncState(branch, { remoteExists: remoteExistsAfter, localRef: "HEAD" });

  printSummaryTable([
    {
      origin: remoteExistsAfter ? `origin/${branch} @ ${originAfter}` : "n/a",
      local: `${branch} @ ${localHead}`,
      status: "Current branch publication state",
      actions: cliOptions.dryRun ? "Dry run only; no remote update occurred." : pushOccurred ? "Branch publication completed." : "No publication was required."
    },
    {
      origin: originBefore || "n/a",
      local: localHead,
      status: "HEAD commit",
      actions: "None."
    },
    {
      origin: remoteExistsAfter ? `origin/${branch} @ ${originAfter}` : "n/a",
      local: `${branch} @ ${localHead}`,
      status: `Upstream sync state: ${formatSyncStatus(syncStateAfter, remoteExistsAfter)}`,
      actions: syncStateAfter.ahead > 0 ? "Remote publication still needs attention." : "Sync verified."
    },
    {
      origin: `${originBefore || "n/a"} -> ${originAfter || "n/a"}`,
      local: pushOccurred ? localHead : "unchanged",
      status: "Remote side effects",
      actions: "Publish did not create a tag, merge, release, or deploy action."
    }
  ]);

  console.log(`Publish ${cliOptions.dryRun ? "plan" : "workflow"} complete for ${branch}.`);
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    list: false
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

    fail(`Unknown option '${arg}'.`);
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-publish.js [--dry-run] [--list]");
  process.exit(exitCode);
}