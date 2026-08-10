#!/usr/bin/env node

/**
 * tctbp-run-release.js — Full release pipeline orchestrator.
 *
 * Composes the existing TCTBP primitives (deploy, promote, ship) into a single
 * deterministic release pipeline: dev → staging → production.
 *
 * Usage:
 *   node scripts/tctbp-run-release.js --no-docs-impact "<reason>" [options]
 *
 * Options:
 *   --docs-updated "<reason>"      User-facing docs were updated
 *   --no-docs-impact "<reason>"    No user-facing docs impact
 *   --version X.Y.Z                Explicit version (default: from version source)
 *   --resume                       Resume the release recorded in the journal
 *   --dry-run                      Print the plan without executing
 *   --yes                          Skip all interactive prompts
 *   --stop-at dev|staging|production Stop at a specific stage
 *   --list                         Show this help
 */

const fs = require("fs");
const { spawnSync } = require("child_process");
const readline = require("readline");
const {
  assertCandidate,
  buildResumeEvidencePlan,
  captureSyncedBranchCandidate,
  fail,
  fetchOrigin,
  getCurrentBranch,
  getWorkingTreeStatus,
  gitRemoteBranchExists,
  loadPolicy,
  logItem,
  logSection,
  markReleaseFailed,
  markReleasePaused,
  markStageCompleted,
  markStageStarted,
  printSummaryTable,
  readReleaseState,
  readVersionSource,
  resolveBranchModel,
  resolveCandidate,
  resolveReleaseStatePath,
  resolveRepoPath,
  runMutableGit,
  runShipGates,
  repoRoot,
  writeReleaseStateAtomic
} = require("./tctbp-core");

const {
  createReleaseState,
  getStageEvidence,
  isStageComplete
} = require("./tctbp-release-state");

const options = require.main === module ? parseArgs(process.argv.slice(2)) : null;

if (require.main === module) {
  main(options).catch((error) => {
    console.error(`\nRelease failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}

function parseArgs(argv) {
  const opts = {
    docsNoteKind: null,
    docsNote: null,
    version: null,
    resume: false,
    dryRun: false,
    yes: false,
    stopAt: null,
    list: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--docs-updated":
        opts.docsNoteKind = "docs-updated";
        opts.docsNote = argv[++i] || "";
        break;
      case "--no-docs-impact":
        opts.docsNoteKind = "no-docs-impact";
        opts.docsNote = argv[++i] || "";
        break;
      case "--version":
        opts.version = argv[++i] || "";
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--yes":
        opts.yes = true;
        break;
      case "--stop-at":
        opts.stopAt = argv[++i] || "";
        if (!["dev", "staging", "production"].includes(opts.stopAt)) {
          console.error(`Invalid --stop-at '${opts.stopAt}'. Expected dev, staging, or production.`);
          printUsage(1);
        }
        break;
      case "--list":
        opts.list = true;
        break;
      default:
        break;
    }
  }

  return opts;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-release.js --no-docs-impact \"<reason>\" [options]");
  console.log("");
  console.log("Options:");
  console.log("  --docs-updated \"<reason>\"      User-facing docs were updated");
  console.log("  --no-docs-impact \"<reason>\"    No user-facing docs impact");
  console.log("  --version X.Y.Z                Explicit version");
  console.log("  --resume                       Resume the journaled release");
  console.log("  --dry-run                      Print the plan without executing or writing state");
  console.log("  --yes                          Skip all interactive prompts");
  console.log("  --stop-at dev|staging|production Stop at a specific stage");
  console.log("  --list                         Show this help");
  process.exit(exitCode);
}

function docsFlag(cliOptions) {
  return cliOptions.docsNoteKind === "docs-updated"
    ? ["--docs-updated", cliOptions.docsNote]
    : ["--no-docs-impact", cliOptions.docsNote];
}

function runStep(stepType, target, requiredBranch, cliOptions, extraArgs = []) {
  const runners = {
    deploy: "scripts/tctbp-run-deploy.js",
    promote: "scripts/tctbp-run-promote.js",
    ship: "scripts/tctbp-run-ship.js"
  };
  const scriptName = runners[stepType];
  if (!scriptName) throw new Error(`Unknown step type: ${stepType}`);

  if (cliOptions.dryRun) {
    console.log(`\n[dry-run] Would run: node ${scriptName} ${target} ${docsFlag(cliOptions).join(" ")} ${extraArgs.join(" ")} (on branch ${requiredBranch})`);
    return;
  }

  const current = getCurrentBranch();
  if (current !== requiredBranch) {
    runMutableGit(["checkout", requiredBranch], false, `Switch to ${requiredBranch} for ${stepType} ${target}`);
  }

  const args = target ? [target, ...docsFlag(cliOptions), ...extraArgs] : [...docsFlag(cliOptions), ...extraArgs];
  const result = spawnSync("node", [resolveRepoPath(scriptName), ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false
  });

  if (result.error) throw new Error(`${stepType} ${target || "release"} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${stepType} ${target || "release"} failed with exit code ${result.status}.`);
}

function prompt(question, cliOptions) {
  if (cliOptions.yes) {
    console.log(`${question} (y/N) y (--yes)`);
    return Promise.resolve(true);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function restoreBranch(branch) {
  try {
    const current = getCurrentBranch();
    if (current !== branch && branch !== "HEAD") {
      runMutableGit(["checkout", branch], false, `Return to ${branch}`);
      console.log(`\nReturned to ${branch}.`);
    }
  } catch {
    console.error(`\nCould not restore original branch '${branch}'. You are on '${getCurrentBranch()}'.`);
  }
}

function initialiseReleaseJournal({ config, version, docsNoteKind, docsNote, stopAt, originalBranch, dryRun, statePath = null }) {
  const path = statePath || resolveReleaseStatePath({ repoRoot, config });
  if (dryRun) return { path, state: null };
  if (fs.existsSync(path)) {
    throw new Error(`A release journal already exists at ${path}. Use --resume to continue it.`);
  }

  const state = createReleaseState({
    version,
    docsNoteKind,
    docsNote,
    stopAt,
    originalBranch,
    config
  });
  writeReleaseStateAtomic(path, state, { config });
  return { path, state };
}

function planReleaseStages(state, config) {
  const plan = buildResumeEvidencePlan(state, { config });
  return {
    ...plan.resume,
    stages: state.stageOrder.map((stage) => ({ stage, complete: isStageComplete(state, stage, { config }) }))
  };
}

function captureCandidate(branch) {
  if (gitRemoteBranchExists(branch)) {
    return captureSyncedBranchCandidate({ repoRoot, branch });
  }
  const candidate = resolveCandidate({ repoRoot, ref: `refs/heads/${branch}`, label: `local ${branch}` });
  return { branch, commit: candidate.commit, tree: candidate.tree };
}

function assertCandidateEvidence(branch, evidence, label = branch) {
  if (!evidence || !evidence.commit || !evidence.tree) {
    throw new Error(`Missing ${label} candidate evidence.`);
  }
  return assertCandidate({
    repoRoot,
    ref: `refs/heads/${branch}`,
    expectedCommit: evidence.commit,
    expectedTree: evidence.tree,
    label
  });
}

function candidateEvidence(candidate) {
  return {
    branch: candidate.branch,
    ...(candidate.remote ? { remote: candidate.remote } : {}),
    commit: candidate.commit,
    tree: candidate.tree
  };
}

function latestCandidate(state, name, branch, config = null) {
  const stages = name === "production" && state.completedStages.shipped
    ? ["shipped", "production-promoted"]
    : name === "staging"
      ? ["staging-deployed", "staging-promoted"]
      : ["development-deployed", "preflight-gates"];

  for (const stage of stages) {
    const evidence = getStageEvidence(state, stage, config ? { config } : {});
    if (evidence && evidence[`${name}Candidate`]) return evidence[`${name}Candidate`];
  }
  return null;
}

function tagNameFor(config, version) {
  const format = config.profile && config.profile.versioning && config.profile.versioning.tagFormat;
  return String(format || "v{version}").replace("{version}", version);
}

function shippedTagEvidence(config, version, candidate) {
  const tag = tagNameFor(config, version);
  const tagCandidate = resolveCandidate({ repoRoot, ref: `refs/tags/${tag}`, label: `release tag ${tag}` });
  if (tagCandidate.commit !== candidate.commit || tagCandidate.tree !== candidate.tree) {
    throw new Error(`Release tag ${tag} does not point at the recorded production candidate.`);
  }
  return { tag, commit: tagCandidate.commit, tree: tagCandidate.tree };
}

function verifyResumeEvidence(state, config) {
  const plan = buildResumeEvidencePlan(state, { config });
  for (const check of plan.checks) {
    if (check.type === "candidate") {
      assertCandidateEvidence(check.candidate.branch, check.candidate, `${check.candidate.branch} candidate`);
      continue;
    }

    if (check.type !== "tag") continue;

    const candidate = check.candidate;
    const evidence = getStageEvidence(state, "shipped", { config });
    const tag = evidence && evidence.tag && (evidence.tag.name || evidence.tag.tag);
    const tagRef = tag || tagNameFor(config, state.version);
    assertCandidate({
      repoRoot,
      ref: `refs/tags/${tagRef}`,
      expectedCommit: candidate.commit,
      expectedTree: candidate.tree,
      label: `release tag ${tagRef}`
    });
  }
  return plan;
}

function writeStageState(context, next) {
  context.state = next;
  writeReleaseStateAtomic(context.statePath, context.state, { config: context.config });
}

async function runStage(context, stage, action) {
  if (context.state && isStageComplete(context.state, stage, { config: context.config })) {
    console.log(`\nSkipping completed release stage: ${stage}.`);
    return false;
  }
  if (context.options.dryRun) {
    await action(null);
    return true;
  }

  try {
    writeStageState(context, markStageStarted(context.state, stage));
    const evidence = await action(context.state);
    writeStageState(context, markStageCompleted(context.state, stage, evidence || {}));
    return true;
  } catch (error) {
    writeStageState(context, markReleaseFailed(context.state, stage, error));
    throw error;
  }
}

async function pauseRelease(context, reason) {
  if (context.options.dryRun) return;
  writeStageState(context, markReleasePaused(context.state, reason));
}

async function main(cliOptions) {
  if (cliOptions.list) printUsage(0);
  if (!cliOptions.resume && (!cliOptions.docsNoteKind || !cliOptions.docsNote)) {
    console.error("Exactly one docs-impact note is required.");
    printUsage(1);
  }

  const config = loadPolicy();
  const currentBranch = getCurrentBranch();
  if (currentBranch === "HEAD") fail("Release stopped because HEAD is detached.");
  if (getWorkingTreeStatus().length > 0) fail("Release stopped because the working tree is not clean.");

  const statePath = resolveReleaseStatePath({ repoRoot, config });
  let state = null;
  let startBranch = currentBranch;
  let version;
  let docsNoteKind = cliOptions.docsNoteKind;
  let docsNote = cliOptions.docsNote;

  if (cliOptions.resume) {
    state = readReleaseState(statePath, { config });
    verifyResumeEvidence(state, config);
    startBranch = state.originalBranch;
    version = state.version;
    docsNoteKind = state.options.docsNoteKind;
    docsNote = state.options.docsNote;
    if (!state.completedStages.finalized && state.status === "completed") {
      fail("Release journal is completed but missing finalization evidence.");
    }
  } else {
    const versionSource = readVersionSource(config);
    version = cliOptions.version || versionSource.version;
    const journal = initialiseReleaseJournal({
      config,
      version,
      docsNoteKind,
      docsNote,
      stopAt: cliOptions.stopAt || "production",
      originalBranch: startBranch,
      dryRun: cliOptions.dryRun,
      statePath
    });
    state = journal.state;
  }

  // Determine branch names from the configured strategy
  const branchModel = resolveBranchModel(config);
  const strategy = branchModel.strategy;
  const devBranch = branchModel.workingBranch || "development";
  const stagingBranch = branchModel.preProductionBranch || "staging";
  const prodBranch = branchModel.productionBranch || "main";
  const useReviewAlias = Boolean(branchModel.reviewBranch);
  const stopAt = cliOptions.stopAt || (cliOptions.resume ? "production" : "production");
  const context = { config, state, statePath, options: { ...cliOptions, docsNoteKind, docsNote, stopAt } };

  logSection("Release");
  logItem("Version", version);
  logItem("Start branch", startBranch);
  logItem("Strategy", strategy);
  logItem("Docs impact", `${docsNoteKind === "docs-updated" ? "Docs updated" : "No docs impact"}: ${docsNote}`);
  logItem("Mode", cliOptions.dryRun ? "dry-run" : cliOptions.resume ? "resume" : "live");
  logItem("Stop at", stopAt);

  // ── Pre-flight gates ─────────────────────────────────────────────────────
  logSection("Pre-flight gates");
  await runStage(context, "preflight-gates", async () => {
    fetchOrigin(cliOptions.dryRun);
    if (!cliOptions.dryRun) runMutableGit(["checkout", devBranch], false, `Switch to ${devBranch} for gates`);
    runShipGates(config, cliOptions.dryRun);
    if (cliOptions.dryRun) return {};
    return { developmentCandidate: candidateEvidence(captureCandidate(devBranch)) };
  });

  // ── Stage 1: Development ─────────────────────────────────────────────────
  logSection("Stage 1: Development");
  const developmentRan = await runStage(context, "development-deployed", async (currentState) => {
    const expected = currentState && latestCandidate(currentState, "development", devBranch, config);
    if (expected && !cliOptions.dryRun) assertCandidateEvidence(devBranch, expected, "development candidate");
    console.log(`\n--- Deploy ${devBranch} ---`);
    runStep("deploy", "dev", devBranch, cliOptions);
    return cliOptions.dryRun ? {} : { developmentCandidate: candidateEvidence(captureCandidate(devBranch)) };
  });

  if (stopAt === "dev" && developmentRan) {
    console.log(`\nStopped at development (--stop-at ${stopAt}).`);
    await pauseRelease(context, "Stopped at development by --stop-at.");
    restoreBranch(startBranch);
    return;
  }
  if (developmentRan && !(await prompt("Development deployed. Continue to staging?", cliOptions))) {
    console.log("Release paused.");
    await pauseRelease(context, "Development deployed; waiting for staging approval.");
    restoreBranch(startBranch);
    return;
  }

  // ── Stage 2: Staging ─────────────────────────────────────────────────────
  logSection("Stage 2: Staging");
  const promoteStagingTarget = useReviewAlias ? "review" : "staging";
  await runStage(context, "staging-promoted", async (currentState) => {
    const expected = currentState && latestCandidate(currentState, "development", devBranch, config);
    if (expected && !cliOptions.dryRun) assertCandidateEvidence(devBranch, expected, "development candidate");
    console.log(`\n--- Promote to ${stagingBranch} ---`);
    runStep("promote", promoteStagingTarget, devBranch, cliOptions);
    return cliOptions.dryRun ? {} : { stagingCandidate: candidateEvidence(captureCandidate(stagingBranch)) };
  });

  const stagingRan = await runStage(context, "staging-deployed", async (currentState) => {
    const expected = currentState && latestCandidate(currentState, "staging", stagingBranch, config);
    if (expected && !cliOptions.dryRun) assertCandidateEvidence(stagingBranch, expected, "staging candidate");
    console.log(`\n--- Deploy ${stagingBranch} ---`);
    runStep("deploy", useReviewAlias ? "review" : "staging", stagingBranch, cliOptions);
    return cliOptions.dryRun ? {} : { stagingCandidate: candidateEvidence(captureCandidate(stagingBranch)) };
  });

  if (stopAt === "staging" && stagingRan) {
    console.log(`\nStopped at staging (--stop-at ${stopAt}).`);
    await pauseRelease(context, "Stopped at staging by --stop-at.");
    restoreBranch(startBranch);
    return;
  }
  if (stagingRan && !(await prompt("Staging deployed. Continue to production?", cliOptions))) {
    console.log("Release paused.");
    await pauseRelease(context, "Staging deployed; waiting for production approval.");
    restoreBranch(startBranch);
    return;
  }

  // ── Stage 3: Production ──────────────────────────────────────────────────
  logSection("Stage 3: Production");
  await runStage(context, "production-promoted", async (currentState) => {
    const expected = currentState && latestCandidate(currentState, "staging", stagingBranch, config);
    if (expected && !cliOptions.dryRun) assertCandidateEvidence(stagingBranch, expected, "staging candidate");
    console.log("\n--- Promote to production ---");
    runStep("promote", "production", stagingBranch, cliOptions);
    return cliOptions.dryRun ? {} : { productionCandidate: candidateEvidence(captureCandidate(prodBranch)) };
  });

  await runStage(context, "shipped", async (currentState) => {
    const expected = currentState && latestCandidate(currentState, "production", prodBranch, config);
    if (expected && !cliOptions.dryRun) assertCandidateEvidence(prodBranch, expected, "production candidate");
    console.log("\n--- Ship ---");
    runStep("ship", "", prodBranch, cliOptions, cliOptions.yes ? ["--yes"] : []);
    if (cliOptions.dryRun) return {};
    const candidate = captureCandidate(prodBranch);
    return { productionCandidate: candidateEvidence(candidate), tag: shippedTagEvidence(config, version, candidate) };
  });

  await runStage(context, "production-deployed", async (currentState) => {
    const expected = currentState && latestCandidate(currentState, "production", prodBranch, config);
    if (expected && !cliOptions.dryRun) assertCandidateEvidence(prodBranch, expected, "production candidate");
    console.log("\n--- Deploy production ---");
    runStep("deploy", "production", prodBranch, cliOptions);
    return cliOptions.dryRun ? {} : { productionCandidate: candidateEvidence(captureCandidate(prodBranch)) };
  });

  // ── Finalize ─────────────────────────────────────────────────────────────
  await runStage(context, "finalized", async () => ({
    version,
    tag: tagNameFor(config, version),
    finalizedAt: new Date().toISOString()
  }));

  logSection("Release complete");
  const finalVersion = readVersionSource(config).version;
  printSummaryTable([
    { origin: "n/a", local: devBranch, status: "Development", actions: `Version: ${finalVersion}` },
    { origin: "n/a", local: stagingBranch, status: "Staging", actions: `Version: ${version}` },
    { origin: "n/a", local: prodBranch, status: "Production", actions: `Version: ${version}` }
  ]);
  console.log(`\nTag: ${tagNameFor(config, version)}`);
  console.log(`Original branch: ${startBranch}`);
  restoreBranch(startBranch);
}

module.exports = {
  captureCandidate,
  initialiseReleaseJournal,
  parseArgs,
  planReleaseStages,
  verifyResumeEvidence
};
