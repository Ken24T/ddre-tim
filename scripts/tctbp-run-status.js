#!/usr/bin/env node
// Size justification: this runner preserves the legacy human status assembly
// while coordinating contract-v1 collection; pure JSON modelling and
// serialisation are split into dedicated modules.

const fs = require("fs");
const path = require("path");
const {
  detectGitOperationState,
  fail,
  fetchOrigin,
  formatSyncStatus,
  getCurrentBranch,
  getHeadCommit,
  getHeadSummary,
  getReachableReleaseTag,
  getShortRef,
  getWorkingTreeStatus,
  gitLocalBranchExists,
  gitRemoteBranchExists,
  gitRemoteTagExists,
  inspectBranchSyncState,
  loadPolicy,
  printSummaryTable,
  readVersionSource,
  repoRoot,
  resolveBranchModel,
  resolveStatusRecommendations,
  summariseWorkingTree
} = require("./tctbp-core");
const { writeJsonDocument } = require("./tctbp-json-output");
const {
  createStatusDocument,
  createStatusErrorDocument
} = require("./tctbp-status-model");

let summaryTablePrinted = false;
const originalProcessExit = process.exit.bind(process);
const argv = process.argv.slice(2);
const jsonRequested = argv.includes("--json");

class StatusRunnerExit extends Error {
  constructor(code) {
    super(`Status runner exited with code ${code}.`);
    this.exitCode = code;
  }
}

if (jsonRequested) {
  process.exit = (code) => {
    throw new StatusRunnerExit(Number(code) || 0);
  };
} else {
  installHumanExitContract();
}

run();

function run() {
  let config = null;

  try {
    const options = parseArgs(argv);

    if (options.list) {
      printUsage(0);
    }

    if (options.json && !options.noFetch) {
      fail("--json requires --no-fetch so inspection never changes remote-tracking state.");
    }

    config = loadPolicy();
    main(config, options);
  } catch (error) {
    if (!jsonRequested) {
      throw error;
    }

    writeJsonDocument(createStatusErrorDocument(config, error));
    originalProcessExit(error instanceof StatusRunnerExit ? error.exitCode || 1 : 1);
  }
}

function installHumanExitContract() {
  process.exit = (code) => {
    const numericCode = typeof code === "number" ? code : Number(code) || 0;
    if (numericCode !== 0 && !summaryTablePrinted) {
      printSummaryTable([
        {
          origin: "n/a",
          local: "status-runner",
          status: "Status run failed before report stage",
          actions: "Review the error above, then rerun: node scripts/tctbp-run-status.js",
        },
      ]);
      summaryTablePrinted = true;
    }

    originalProcessExit(numericCode);
  };
}

function main(config, cliOptions) {
  if (!cliOptions.noFetch) {
    fetchOrigin(false, true);
  }

  const currentBranch = getCurrentBranch();
  const branchModel = resolveBranchModel(config);
  const defaultBranch = branchModel.productionBranch;
  const significantBranches = branchModel.significantBranches;
  const workingTreeSummary = summariseWorkingTree(getWorkingTreeStatus());
  const operationStates = detectGitOperationState();
  const branchStates = significantBranches.map((branchName) => getBranchState(branchName, currentBranch));
  const currentRemoteExists = currentBranch === "HEAD" ? false : gitRemoteBranchExists(currentBranch);
  const currentSyncState =
    currentBranch === "HEAD"
      ? {
          ahead: 0,
          behind: 0,
          diverged: false
        }
      : inspectBranchSyncState(currentBranch, { remoteExists: currentRemoteExists, localRef: "HEAD" });
  const currentLocalSha = getHeadCommit(true);
  const currentOriginSha = currentRemoteExists ? getShortRef(`refs/remotes/origin/${currentBranch}`) : null;
  const defaultRemoteExists = gitRemoteBranchExists(defaultBranch);
  const defaultSyncState = inspectBranchSyncState(defaultBranch, { remoteExists: defaultRemoteExists });
  const defaultLocalSha = getShortRef(`refs/heads/${defaultBranch}`);
  const defaultOriginSha = defaultRemoteExists ? getShortRef(`refs/remotes/origin/${defaultBranch}`) : null;
  const localTag = getReachableReleaseTag(config);
  const remoteTag = localTag && gitRemoteTagExists(localTag) ? localTag : null;
  const versionSource = readVersionSource(config);

  // Detect handover continuation files
  let handoverContinuationCount = 0;
  try {
    const contDir = path.join(repoRoot, ".tctbp", "continuation");
    if (fs.existsSync(contDir)) {
      handoverContinuationCount = fs.readdirSync(contDir).filter((name) => name.endsWith(".md")).length;
    }
  } catch (_) {
    // Directory not readable — skip.
  }

  const shipReadiness = resolveShipReadiness({
    currentBranch,
    currentRemoteExists,
    currentSyncState,
    defaultBranch,
    localTag,
    workingTreeSummary
  });
  const handoverReadiness = resolveHandoverReadiness({
    currentBranch,
    currentRemoteExists,
    currentSyncState,
    operationStates,
    workingTreeSummary
  });
  const recommendations = resolveStatusRecommendations({
    currentBranch,
    currentRemoteExists,
    currentSyncState,
    defaultBranch,
    operationStates,
    shipReadiness,
    workingTreeSummary,
    enableHandoverSuggestions: cliOptions.forHandover
  });
  const branchRecommendations = getBranchRecommendations(branchStates, currentBranch);
  const workflowRecommendations = expandWorkflowRecommendations(recommendations);
  const combinedRecommendations = Array.from(new Set([...workflowRecommendations, ...branchRecommendations]));
  const suggestedCommand = cliOptions.suggest ? resolveSuggestedCommand(recommendations) : null;
  const overallHealth = getOverallHealth({
    branchStates,
    operationStates,
    workingTreeSummary,
    currentBranch,
  });

  if (cliOptions.json) {
    writeJsonDocument(
      createStatusDocument({
        config,
        fetchPerformed: !cliOptions.noFetch,
        branchModel,
        currentBranch,
        currentLocalSha,
        currentOriginSha,
        currentRemoteExists,
        currentSyncState,
        workingTreeSummary,
        operationStates,
        branchStates,
        localTag,
        remoteTag,
        versionSource,
        handoverContinuationCount,
        recommendations
      })
    );
    return;
  }

  printSummaryTable([
    {
      origin: "n/a",
      local: overallHealth.local,
      status: `Overall health: ${overallHealth.status}`,
      actions: overallHealth.actions,
    },
    ...branchStates.map((state) => ({
      origin: state.origin,
      local: state.local,
      status: state.status,
      actions: state.actions,
    })),
    {
      origin: currentOriginSha || "n/a",
      local: getHeadSummary(),
      status: "HEAD commit",
      actions: "None."
    },
    {
      origin: defaultRemoteExists ? `origin/${defaultBranch} @ ${defaultOriginSha}` : "n/a",
      local: defaultLocalSha ? `${defaultBranch} @ ${defaultLocalSha}` : `${defaultBranch} missing locally`,
      status: `Default branch: ${formatSyncStatus(defaultSyncState, defaultRemoteExists)}`,
      actions: defaultLocalSha ? "None." : "Create or fetch the default branch before using it."
    },
    {
      origin: remoteTag || "n/a",
      local: localTag || "none reachable from HEAD",
      status: "Last shipped tag",
      actions: localTag && !remoteTag ? "Remote tag is missing; recover with ship or abort as appropriate." : "None."
    },
    {
      origin: "n/a",
      local: workingTreeSummary.summary,
      status: "Working tree",
      actions: workingTreeSummary.isClean ? "None." : "Use checkpoint before publish, handover, or branch-changing workflows."
    },
    {
      origin: "n/a",
      local: `${versionSource.path} = ${versionSource.version}`,
      status: "Version source",
      actions: "None."
    },
    {
      origin: "n/a",
      local: operationStates.length > 0 ? operationStates.join(", ") : handoverContinuationCount > 0 ? `${handoverContinuationCount} continuation file(s)` : "none recorded",
      status: "Handover metadata / partial state",
      actions: operationStates.length > 0 ? "Use abort before any other mutating workflow." : handoverContinuationCount > 0 ? "Run resume or say orient to load the continuation context." : "Repo does not keep separate handover metadata."
    },
    {
      origin: defaultRemoteExists ? defaultOriginSha || "n/a" : "n/a",
      local: shipReadiness.local,
      status: "Ship readiness",
      actions: shipReadiness.action
    },
    {
      origin: currentRemoteExists ? currentOriginSha || "n/a" : "n/a",
      local: handoverReadiness.local,
      status: "Handover readiness",
      actions: handoverReadiness.action
    }
  ]);
  summaryTablePrinted = true;

  console.log("Recommendations:");
  for (const recommendation of combinedRecommendations) {
    console.log(`- ${recommendation}`);
  }

  if (cliOptions.suggest) {
    console.log("");
    if (!suggestedCommand) {
      console.log("Suggested command: none (no single non-destructive recommendation).");
    } else {
      console.log(`Suggested command: ${suggestedCommand}`);
    }
  }
}

function resolveSuggestedCommand(tokens) {
  if (!Array.isArray(tokens) || tokens.length !== 1) {
    return null;
  }

  const token = tokens[0];
  if (!token || token === "none") {
    return null;
  }

  const commandMap = {
    abort: "node scripts/tctbp-run-abort.js --dry-run",
    resume: "node scripts/tctbp-run-resume.js --dry-run",
    checkpoint: "node scripts/tctbp-run-checkpoint.js --dry-run",
    publish: "node scripts/tctbp-run-publish.js --dry-run",
    ship: "node scripts/tctbp-run-ship.js --dry-run --no-docs-impact \"Status suggested dry-run\"",
    handover: "node scripts/tctbp-run-handover.js --dry-run",
  };

  return commandMap[token] || null;
}

function getBranchState(branchName, currentBranch) {
  const localExists = gitLocalBranchExists(branchName);
  const remoteExists = gitRemoteBranchExists(branchName);
  const localSha = localExists ? getShortRef(`refs/heads/${branchName}`) : null;
  const remoteSha = remoteExists ? getShortRef(`refs/remotes/origin/${branchName}`) : null;
  const syncState = localExists && remoteExists ? inspectBranchSyncState(branchName, { remoteExists }) : null;
  const isCurrentBranch = currentBranch === branchName;
  const statusPrefix = isCurrentBranch ? `${branchName} (current)` : branchName;

  if (!localExists) {
    return {
      branchName,
      localExists,
      remoteExists,
      localSha,
      remoteSha,
      syncState,
      origin: remoteExists ? `origin/${branchName} @ ${remoteSha}` : "n/a",
      local: `${branchName} missing locally`,
      status: `${statusPrefix}: missing locally`,
      actions: `Create or fetch ${branchName} before using this workflow branch.`,
    };
  }

  if (!remoteExists) {
    return {
      branchName,
      localExists,
      remoteExists,
      localSha,
      remoteSha,
      syncState,
      origin: "n/a",
      local: `${branchName} @ ${localSha}`,
      status: `${statusPrefix}: unpublished branch`,
      actions: `Publish ${branchName} to origin when you need branch-backed continuity.`,
    };
  }

  return {
    branchName,
    localExists,
    remoteExists,
    localSha,
    remoteSha,
    syncState,
    origin: `origin/${branchName} @ ${remoteSha}`,
    local: `${branchName} @ ${localSha}`,
    status: `${statusPrefix}: ${formatSyncStatus(syncState, true)}`,
    actions: resolveBranchAction(branchName, syncState),
  };
}

function resolveBranchAction(branchName, syncState) {
  if (syncState.diverged) {
    return `Resolve divergence on ${branchName} before promote/deploy workflows.`;
  }

  if (syncState.behind > 0) {
    return `Fast-forward ${branchName} from origin/${branchName} before mutating workflows.`;
  }

  if (syncState.ahead > 0) {
    return `Push ${branchName} to origin to restore branch-backed continuity.`;
  }

  return "None.";
}

function getBranchRecommendations(branchStates, currentBranch) {
  const recommendations = [];

  for (const state of branchStates) {
    recommendations.push(
      state.actions === "None."
        ? `${state.branchName}: in sync, no action needed.`
        : `${state.branchName}: ${state.actions}`
    );
  }

  const branchSet = new Set(branchStates.map((s) => s.branchName));
  const isOnConfiguredBranch = branchSet.has(currentBranch);

  if (!isOnConfiguredBranch && currentBranch !== "HEAD") {
    const branchNames = Array.from(branchSet).join("/");
    recommendations.push(`current branch '${currentBranch}': use ${branchNames} for the primary TCTBP lifecycle workflows.`);
  }

  if (currentBranch === "HEAD") {
    const branchNames = Array.from(branchSet).join("/");
    recommendations.push(`detached HEAD: reattach to ${branchNames} before mutating workflows.`);
  }

  return recommendations;
}

function expandWorkflowRecommendations(tokens) {
  const tokenMap = {
    abort: "workflow state: an unfinished git operation was detected; run 'abort' to inspect safe recovery options before continuing.",
    investigate: "repository state: automatic workflow advice is unsafe; inspect the detached, diverged, or compound dirty/behind state before continuing.",
    resume: "branch sync: local state is behind origin; run 'resume' to fast-forward safely.",
    checkpoint: "working tree: local changes are present; run 'checkpoint' before promotion/deploy actions.",
    publish: "publication: local branch has unpublished commits; run 'publish' to update origin.",
    ship: "release readiness: main appears ship-ready; run 'ship' only when the production candidate is approved.",
    handover: "handover readiness: if you need continuity on another machine, run 'handover'.",
    none: "overall: everything looks healthy right now; no immediate action is required."
  };

  return tokens.map((token) => tokenMap[token] || token);
}

function getOverallHealth(input) {
  const issues = [];

  for (const state of input.branchStates) {
    if (state.actions !== "None.") {
      issues.push(state.branchName);
    }
  }

  if (input.operationStates.length > 0) {
    issues.push("pending git operation state");
  }

  if (!input.workingTreeSummary.isClean) {
    issues.push("dirty working tree");
  }

  if (input.currentBranch === "HEAD") {
    issues.push("detached HEAD");
  }

  if (issues.length === 0) {
    return {
      status: "OK",
      local: "All key checks passed",
      actions: "None.",
    };
  }

  return {
    status: `Needs attention (${issues.length})`,
    local: issues.join(", "),
    actions: "See Recommendations for next steps.",
  };
}

function resolveShipReadiness(input) {
  if (input.currentBranch !== input.defaultBranch) {
    return {
      local: `Not on ${input.defaultBranch}`,
      action: `Switch to ${input.defaultBranch} after promote production when a release candidate is approved.`,
      ready: false
    };
  }

  if (!input.workingTreeSummary.isClean) {
    return {
      local: "Blocked by dirty working tree",
      action: "Checkpoint or clean the tree before ship.",
      ready: false
    };
  }

  if (input.currentSyncState.diverged || input.currentSyncState.behind > 0) {
    return {
      local: "Blocked by branch sync state",
      action: "Recover sync with origin before ship.",
      ready: false
    };
  }

  if (input.localTag) {
    return {
      local: `Release tag reachable: ${input.localTag}`,
      action: "Inspect whether this is already a shipped release or a partial release state.",
      ready: false
    };
  }

  return {
    local: "Ready from clean main",
    action: "Run ship when the production candidate is approved.",
    ready: true
  };
}

function resolveHandoverReadiness(input) {
  if (input.operationStates.length > 0) {
    return {
      local: `Blocked by ${input.operationStates.join(", ")}`,
      action: "Resolve partial workflow state before handover."
    };
  }

  if (!input.workingTreeSummary.isClean) {
    return {
      local: "Dirty branch can be handed over",
      action: "If you are moving to another machine, run handover to preserve and publish the current branch state."
    };
  }

  if (input.currentRemoteExists === false || input.currentSyncState.ahead > 0) {
    return {
      local: "Unpublished work is present",
      action: "If you are moving to another machine, run handover so the current branch is available remotely."
    };
  }

  return {
    local: "Already clean and synced",
    action: "No handover is needed right now."
  };
}

function parseArgs(argv) {
  const parsed = {
    list: false,
    noFetch: false,
    forHandover: false,
    suggest: false,
    json: false
  };

  for (const arg of argv) {
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    if (arg === "--no-fetch") {
      parsed.noFetch = true;
      continue;
    }

    if (arg === "--for-handover") {
      parsed.forHandover = true;
      continue;
    }

    if (arg === "--suggest") {
      parsed.suggest = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    fail(`Unknown option '${arg}'.`);
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-status.js [--no-fetch] [--json] [--for-handover] [--suggest] [--list]");
  process.exit(exitCode);
}
