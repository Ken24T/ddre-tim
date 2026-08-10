#!/usr/bin/env node

const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const {
  fail,
  getCurrentBranch,
  getWorkingTreeStatus,
  loadPolicy,
  printDirtySummary,
  repoRoot,
  summariseWorkingTree
} = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printUsage(0);
}

main(loadPolicy(), options).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main(config, cliOptions) {
  if (cliOptions.workflow === "branch") {
    const branchArgs = [];
    if (cliOptions.target) {
      branchArgs.push(cliOptions.target);
    }
    branchArgs.push(...cliOptions.passthroughArgs);

    const result = spawnSync(process.execPath, [path.join(__dirname, "tctbp-run-branch.js"), ...branchArgs], {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env
    });

    if (result.error) {
      fail(result.error.message);
    }

    process.exit(result.status === null ? 1 : result.status);
  }

  const targetInfo = resolveTargetInfo(config, cliOptions.workflow, cliOptions.target);
  const passthroughArgs = [...cliOptions.passthroughArgs];

  if (cliOptions.workflow === "deploy" && targetInfo.key === "dev") {
    await maybeHandleGuidedDirtyDeploy(targetInfo, passthroughArgs);
  }

  if (cliOptions.workflow === "promote" && (targetInfo.key === "staging" || targetInfo.key === "review")) {
    await maybeHandleGuidedDirtyPromote(targetInfo, passthroughArgs);
  }

  const scriptName = cliOptions.workflow === "deploy" ? "tctbp-run-deploy.js" : "tctbp-run-promote.js";
  const result = spawnSync(process.execPath, [path.join(__dirname, scriptName), targetInfo.key, ...passthroughArgs], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env
  });

  if (result.error) {
    fail(result.error.message);
  }

  process.exit(result.status === null ? 1 : result.status);
}

async function maybeHandleGuidedDirtyDeploy(targetInfo, passthroughArgs) {
  const branch = getCurrentBranch();

  if (branch !== targetInfo.target.expectedBranch) {
    return;
  }

  const workingTreeStatus = getWorkingTreeStatus();
  const workingTreeSummary = summariseWorkingTree(workingTreeStatus);

  if (workingTreeSummary.isClean || passthroughArgs.includes("--allow-dirty-sync")) {
    return;
  }

  if (!targetInfo.target.allowCommitBeforeDeploy || targetInfo.target.requireExplicitDirtySyncConfirmation !== true) {
    return;
  }

  printDirtySummary(
    workingTreeStatus,
    "Guided dirty deploy sync summary",
    "These paths will be staged into the deploy sync commit if you continue:"
  );

  const approved = await askYesNo("Create the development deploy sync commit and continue? (y/N) ");

  if (!approved) {
    fail("Deploy stopped because the dirty sync was not confirmed.");
  }

  passthroughArgs.push("--allow-dirty-sync");

  if (targetInfo.target.optionalCheckpointBeforeDirtySync) {
    const checkpointApproved = await askYesNo("Create a local checkpoint branch before the deploy sync commit? (y/N) ");

    if (checkpointApproved) {
      passthroughArgs.push("--checkpoint-before-dirty-sync");
    }
  }
}

async function maybeHandleGuidedDirtyPromote(targetInfo, passthroughArgs) {
  const branch = getCurrentBranch();

  if (branch !== targetInfo.target.sourceBranch) {
    return;
  }

  const workingTreeStatus = getWorkingTreeStatus();
  const workingTreeSummary = summariseWorkingTree(workingTreeStatus);

  if (workingTreeSummary.isClean || passthroughArgs.includes("--allow-dirty-source-sync")) {
    return;
  }

  if (!targetInfo.target.allowDirtySourceSync || targetInfo.target.requireExplicitDirtySourceSyncConfirmation !== true) {
    return;
  }

  printDirtySummary(
    workingTreeStatus,
    "Guided dirty promotion sync summary",
    "These paths will be staged into the source sync commit if you continue:"
  );

  const approved = await askYesNo("Create the source sync commit and continue with promotion? (y/N) ");

  if (!approved) {
    fail("Promotion stopped because the dirty source sync was not confirmed.");
  }

  passthroughArgs.push("--allow-dirty-source-sync");

  if (targetInfo.target.optionalCheckpointBeforeDirtySourceSync) {
    const checkpointApproved = await askYesNo("Create a local checkpoint branch before the source sync commit? (y/N) ");

    if (checkpointApproved) {
      passthroughArgs.push("--checkpoint-before-dirty-source-sync");
    }
  }
}

function askYesNo(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(["y", "yes"].includes(String(answer).trim().toLowerCase()));
    });
  });
}

function resolveTargetInfo(config, workflow, targetArg) {
  const targets = workflow === "deploy" ? config.deploy.targets : config.promote.targets;
  const normalized = String(targetArg).toLowerCase();

  for (const [key, target] of Object.entries(targets)) {
    const names = [key, ...(target.aliases || [])].map((value) => String(value).toLowerCase());

    if (names.includes(normalized)) {
      return { key, target };
    }
  }

  fail(`Unknown ${workflow} target '${targetArg}'.`);
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--list") {
    return {
      list: true,
      passthroughArgs: [],
      target: null,
      workflow: null
    };
  }

  const workflow = argv[0];
  let target = argv[1];
  let passthroughArgs = argv.slice(2);

  if (!workflow) {
    printUsage(1);
  }

  if (!["deploy", "promote", "branch"].includes(workflow)) {
    fail(`Unknown workflow '${workflow}'. Expected 'deploy', 'promote', or 'branch'.`);
  }

  if (workflow === "branch") {
    if (target && target.startsWith("--")) {
      target = null;
      passthroughArgs = argv.slice(1);
    }

    return {
      list: false,
      passthroughArgs,
      target,
      workflow
    };
  }

  if (["deploy", "promote"].includes(workflow) && !target) {
    printUsage(1);
  }

  return {
    list: false,
    passthroughArgs,
    target,
    workflow
  };
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-workflow.js <deploy|promote> <target> [runner options...] | branch [new-branch-name] [runner options...] | --list");
  process.exit(exitCode);
}
