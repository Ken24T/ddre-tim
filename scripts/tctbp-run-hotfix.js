#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { resolvePolicyPath, resolveRepoRoot } = require("./tctbp-runtime");
const {
  fail,
  fetchOrigin,
  getCurrentBranch,
  getShortRef,
  getWorkingTreeStatus,
  gitLocalBranchExists,
  gitRemoteBranchExists,
  inspectBranchSyncState,
  loadPolicy,
  logItem,
  logSection,
  printDirtySummary,
  printSummaryTable,
  resolveBranchModel,
  resolveRepoPath,
  runMutableGit,
  runVerificationGates,
  stopIfBehindOrDiverged,
  summariseWorkingTree,
} = require("./tctbp-core");

const repoRoot = resolveRepoRoot();
const policyPath = resolvePolicyPath(repoRoot);

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printUsage(0);
}

if (!options.mode) {
  console.error("Missing hotfix mode. Use 'start <name>' or 'finish'.");
  printUsage(1);
}

if (options.mode === "finish" && (!options.docsNoteKind || !options.docsNote)) {
  console.error("Exactly one docs-impact note is required for finish. Use --docs-updated \"<reason>\" or --no-docs-impact \"<reason>\".");
  printUsage(1);
}

main(loadPolicy(), options);

function buildHotfixBranchName(name) {
  return `hotfix/${name.replace(/[^a-zA-Z0-9._/-]+/g, "-")}`;
}

function ensureBranch(repoRoot, branchName) {
  if (gitLocalBranchExists(branchName)) return;
  if (!gitRemoteBranchExists(branchName)) {
    fail(`Hotfix workflow stopped because '${branchName}' does not exist locally or on origin.`);
  }
  runMutableGit(
    ["switch", "-c", branchName, "--track", `origin/${branchName}`],
    false,
    `Create local ${branchName} from origin/${branchName}`,
  );
}

function publishBranch(branchName, dryRun) {
  const remoteExists = gitRemoteBranchExists(branchName);
  if (remoteExists) {
    const state = inspectBranchSyncState(branchName, { remoteExists, localRef: "HEAD" });
    stopIfBehindOrDiverged(state, `origin/${branchName}`, "Hotfix");
  }
  if (dryRun) {
    console.log(`[dry-run] Would push ${branchName} to origin.`);
    return;
  }
  runMutableGit(
    ["push", remoteExists ? "origin" : "-u", remoteExists ? branchName : `origin`, branchName],
    false,
    `Publish ${branchName}`,
  );
}

function main(config, cliOptions) {
  const branchModel = resolveBranchModel(config);
  const productionBranch = branchModel.productionBranch;
  const preProductionBranch = branchModel.preProductionBranch;
  const workingBranch = branchModel.workingBranch;
  const currentBranch = getCurrentBranch();

  if (currentBranch === "HEAD") {
    fail("Hotfix workflow stopped because HEAD is detached.");
  }

  if (cliOptions.mode === "start") {
    if (!cliOptions.hotfixName) {
      fail("Hotfix start requires a name. Example: node scripts/tctbp-run-hotfix.js start login-timeout");
    }
    if (currentBranch !== productionBranch) {
      fail(`Hotfix start requires the production branch '${productionBranch}'. Current branch: '${currentBranch}'.`);
    }

    const status = getWorkingTreeStatus();
    const dirtySummary = summariseWorkingTree(status);
    if (!dirtySummary.isClean) {
      printDirtySummary(status, "Hotfix working tree summary", "These paths must be committed before starting the hotfix:");
      fail("Hotfix start stopped because the working tree is dirty. Preserve your work before starting a hotfix.");
    }

    fetchOrigin(cliOptions.dryRun, true);

    const remoteExists = gitRemoteBranchExists(productionBranch);
    if (remoteExists) {
      const syncState = inspectBranchSyncState(productionBranch, { remoteExists, localRef: "HEAD" });
      stopIfBehindOrDiverged(syncState, `origin/${productionBranch}`, "Hotfix");
    }

    const hotfixBranch = buildHotfixBranchName(cliOptions.hotfixName);
    if (gitLocalBranchExists(hotfixBranch)) {
      fail(`Hotfix branch '${hotfixBranch}' already exists locally.`);
    }
    if (gitRemoteBranchExists(hotfixBranch)) {
      fail(`Hotfix branch '${hotfixBranch}' already exists on origin.`);
    }

    logSection("Hotfix start");
    logItem("Production branch", productionBranch);
    logItem("Hotfix branch", hotfixBranch);
    logItem("Mode", cliOptions.dryRun ? "dry-run" : "live");

    if (cliOptions.dryRun) {
      console.log(`[dry-run] Would create and switch to ${hotfixBranch} from ${productionBranch}.`);
    } else {
      runMutableGit(["switch", "-c", hotfixBranch], false, `Create and switch to hotfix branch ${hotfixBranch}`);
    }

    printSummaryTable([
      {
        origin: remoteExists ? `origin/${productionBranch} @ ${getShortRef(`refs/remotes/origin/${productionBranch}`) || "n/a"}` : "n/a",
        local: `${productionBranch} @ ${getShortRef(`refs/heads/${productionBranch}`) || "n/a"}`,
        status: "Production baseline",
        actions: "Hotfix branch will be created from this commit.",
      },
      {
        origin: "n/a",
        local: cliOptions.dryRun ? hotfixBranch : getCurrentBranch(),
        status: "Active branch",
        actions: cliOptions.dryRun ? `Would create ${hotfixBranch}.` : `Now on ${hotfixBranch}. Make the fix and then run finish.`,
      },
    ]);

    console.log("\nNext: make the minimal fix, then run:");
    console.log(`  node scripts/tctbp-run-hotfix.js finish --no-docs-impact \"hotfix: <reason>\"`);
    return;
  }

  if (cliOptions.mode === "finish") {
    if (!currentBranch.startsWith("hotfix/")) {
      fail(`Hotfix finish must run from a hotfix/* branch. Current branch: '${currentBranch}'.`);
    }
    const hotfixBranch = currentBranch;

    if (!productionBranch) {
      fail("Hotfix workflow stopped because the branch model has no production branch.");
    }

    const status = getWorkingTreeStatus();
    const dirtySummary = summariseWorkingTree(status);
    if (!dirtySummary.isClean) {
      printDirtySummary(status, "Hotfix working tree summary", "These paths must be committed before finishing the hotfix:");
      fail("Hotfix finish stopped because the working tree is dirty. Checkpoint before finishing.");
    }

    fetchOrigin(cliOptions.dryRun, true);

    const hotfixRemoteExists = gitRemoteBranchExists(hotfixBranch);
    if (hotfixRemoteExists) {
      const hotfixSync = inspectBranchSyncState(hotfixBranch, { remoteExists: true, localRef: "HEAD" });
      stopIfBehindOrDiverged(hotfixSync, `origin/${hotfixBranch}`, "Hotfix");
    }

    ensureBranch(repoRoot, productionBranch);

    logSection("Hotfix finish");
    logItem("Hotfix branch", hotfixBranch);
    logItem("Production branch", productionBranch);
    logItem("Pre-production branch", preProductionBranch || "n/a");
    logItem("Working branch", workingBranch || "n/a");
    logItem("Bump", cliOptions.bump);
    logItem("Mode", cliOptions.dryRun ? "dry-run" : "live");

    if (!cliOptions.dryRun) {
      runVerificationGates(config, cliOptions.dryRun, "Hotfix");
    } else {
      console.log("[dry-run] Would run verification gates before merging.");
    }

    // Merge hotfix into production branch, then ship from there.
    runMutableGit(["switch", productionBranch], cliOptions.dryRun, `Switch to ${productionBranch}`);
    runMutableGit(
      ["merge", "--no-ff", "--no-edit", hotfixBranch],
      cliOptions.dryRun,
      `Merge ${hotfixBranch} into ${productionBranch}`,
    );

    if (cliOptions.dryRun) {
      console.log(`[dry-run] Would run ship with --bump ${cliOptions.bump}.`);
    } else {
      const shipArgs = [
        resolveRepoPath(repoRoot, "scripts/tctbp-run-ship.js"),
        "--bump",
        cliOptions.bump,
        `--${cliOptions.docsNoteKind}`,
        cliOptions.docsNote,
        "--yes",
      ];
      execFileSync(process.execPath, shipArgs, { cwd: repoRoot, stdio: "inherit" });
    }

    // Backport the shipped production branch into the pre-production and working branches.
    const backportBranches = [preProductionBranch, workingBranch].filter(Boolean);
    for (const branch of backportBranches) {
      if (!branch) continue;
      ensureBranch(repoRoot, branch);
      runMutableGit(["switch", branch], cliOptions.dryRun, `Switch to ${branch}`);
      const branchRemoteExists = gitRemoteBranchExists(branch);
      if (branchRemoteExists) {
        const branchSync = inspectBranchSyncState(branch, { remoteExists: true, localRef: "HEAD" });
        stopIfBehindOrDiverged(branchSync, `origin/${branch}`, "Hotfix");
      }
      runMutableGit(
        ["merge", "--no-ff", "--no-edit", productionBranch],
        cliOptions.dryRun,
        `Backport ${productionBranch} into ${branch}`,
      );
      publishBranch(branch, cliOptions.dryRun);
    }

    // Clean up the local hotfix branch.
    runMutableGit(["branch", "-d", hotfixBranch], cliOptions.dryRun, `Delete local ${hotfixBranch}`);

    // Leave the user on the working branch.
    if (workingBranch) {
      runMutableGit(["switch", workingBranch], cliOptions.dryRun, `Switch to ${workingBranch}`);
    }

    const reportBranches = {
      [productionBranch]: getShortRef(`refs/heads/${productionBranch}`) || "n/a",
    };
    if (preProductionBranch) {
      reportBranches[preProductionBranch] = getShortRef(`refs/heads/${preProductionBranch}`) || "n/a";
    }
    if (workingBranch) {
      reportBranches[workingBranch] = getShortRef(`refs/heads/${workingBranch}`) || "n/a";
    }

    const rows = Object.entries(reportBranches).map(([branch, sha]) => ({
      origin: branch === productionBranch
        ? (gitRemoteBranchExists(branch) ? `origin/${branch} @ ${getShortRef(`refs/remotes/origin/${branch}`) || "n/a"}` : "n/a")
        : (gitRemoteBranchExists(branch) ? `origin/${branch} @ ${getShortRef(`refs/remotes/origin/${branch}`) || "n/a"}` : "n/a"),
      local: `${branch} @ ${sha}`,
      status: branch === productionBranch ? "Shipped and tagged" : "Backported",
      actions: branch === productionBranch ? "Production release complete." : "Hotfix merged and published.",
    }));

    printSummaryTable(rows);

    console.log("\nNext steps:");
    console.log(`- Deploy ${productionBranch} to the production environment if not already automated.`);
    if (workingBranch) {
      console.log(`- Resume normal development work from ${workingBranch}.`);
    }

    console.log("\nHotfix workflow complete.");
    return;
  }

  console.error(`Unknown hotfix mode '${cliOptions.mode}'.`);
  printUsage(1);
}

function parseArgs(argv) {
  const parsed = {
    bump: "patch",
    docsNoteKind: null,
    docsNote: null,
    dryRun: false,
    hotfixName: null,
    list: false,
    mode: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "start":
      case "finish": {
        parsed.mode = arg;
        if (arg === "start" && index + 1 < argv.length && !argv[index + 1].startsWith("-")) {
          parsed.hotfixName = argv[index + 1];
          index += 1;
        }
        break;
      }
      case "--bump": {
        const value = argv[index + 1];
        if (!value || !["patch", "minor", "major"].includes(value)) {
          fail("--bump requires one of: patch, minor, major.");
        }
        parsed.bump = value;
        index += 1;
        break;
      }
      case "--docs-updated":
      case "--no-docs-impact": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          fail(`${arg} requires a quoted reason.`);
        }
        if (parsed.docsNoteKind) {
          fail("Provide only one docs-impact flag.");
        }
        parsed.docsNoteKind = arg === "--docs-updated" ? "docs-updated" : "no-docs-impact";
        parsed.docsNote = value;
        index += 1;
        break;
      }
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--list":
        parsed.list = true;
        break;
      default:
        fail(`Unknown option '${arg}'.`);
    }
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log(
    "Usage: node scripts/tctbp-run-hotfix.js {start <name> | finish} [--bump patch|minor|major] [--docs-updated \"<reason>\" | --no-docs-impact \"<reason>\"] [--dry-run] [--list]"
  );
  process.exit(exitCode);
}
