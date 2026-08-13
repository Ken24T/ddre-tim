#!/usr/bin/env node

/**
 * scripts/tctbp-run-preflight.js
 *
 * Preflight: the formalised non-mutating aggregate verification workflow
 * (Workstream B of the ecosystem consolidation plan).
 *
 * Answer: "Is the current working state healthy enough to preserve, publish,
 * hand over, promote, deploy, or otherwise advance?"
 *
 * Runs applicable configured checks against the current working state —
 * including uncommitted changes — and reports a concise PASS / FAIL /
 * NOT-CONFIGURED summary.
 *
 * Required non-effects: preflight never commits, pushes, tags, merges,
 * switches branch, deploys, bumps a version, creates release state, or
 * modifies remote state. If a configured gate itself writes files, the
 * side effect is detected and reported rather than silently accepted.
 */

const { spawnSync } = require("child_process");
const {
  resolveRepoRoot,
  resolveRuntimeCwd,
  resolvePolicyPath
} = require("./tctbp-runtime");
const {
  detectGitOperationState,
  getCurrentBranch,
  getWorkingTreeStatus
} = require("./tctbp-git-ops");
const { loadPolicy } = require("./tctbp-profile-io");
const { resolveProfileCommand } = require("./tctbp-gates");
const { fail, logSection } = require("./tctbp-output");

const repoRoot = resolveRepoRoot();
const runtimeCwd = resolveRuntimeCwd(repoRoot);
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const listOnly = args.includes("--list");

const GATE_ORDER = [
  ["format", "Format"],
  ["test", "Test"],
  ["lint", "Lint"],
  ["build", "Build"],
  ["release-build", "Release build"]
];

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-preflight.js [--dry-run] [--list]");
  process.exit(exitCode || 0);
}

function runShellCapture(command) {
  return spawnSync(command, {
    cwd: runtimeCwd,
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function sortedStatusLines(statusOutput) {
  return String(statusOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

function escapeTableCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function printTable(rows) {
  console.log("");
  console.log("| " + rows[0].map((cell) => escapeTableCell(cell)).join(" | ") + " |");
  console.log("| " + rows[0].map(() => "---").join(" | ") + " |");
  for (const row of rows.slice(1)) {
    console.log("| " + row.map((cell) => escapeTableCell(cell)).join(" | ") + " |");
  }
  console.log("");
}

function main() {
  if (listOnly) {
    printUsage(0);
  }

  const policy = loadPolicy();
  const profile = policy.profile || {};
  const commands = profile.commands || {};

  let overall = "PASS";
  const results = [];

  logSection("Preflight — non-mutating verification");

  // 1. Git/repository sanity inspection.
  let branch = "unknown";
  try {
    branch = getCurrentBranch();
  } catch (error) {
    overall = "FAIL";
  }
  const detached = branch === "HEAD";
  results.push([
    "Git sanity",
    detached ? "FAIL" : "PASS",
    detached ? "detached HEAD" : `on ${branch}`
  ]);
  if (detached) {
    overall = "FAIL";
  }

  // 2. Active operation / conflict detection.
  const activeOps = detectGitOperationState();
  results.push([
    "Active operation",
    activeOps.length === 0 ? "PASS" : "FAIL",
    activeOps.length === 0 ? "none" : activeOps.join(", ")
  ]);
  if (activeOps.length > 0) {
    overall = "FAIL";
  }

  // 3. Working-tree state before verification (uncommitted changes included).
  const treeBefore = sortedStatusLines(getWorkingTreeStatus());
  results.push([
    "Working tree",
    treeBefore.length === 0 ? "CLEAN" : "DIRTY",
    treeBefore.length === 0
      ? "clean"
      : `${treeBefore.length} pre-existing change(s)`
  ]);

  // 4. Configured quality gates (test / lint / build / format / release-build).
  const gateRows = [["Gate", "Result", "Command / note"]];
  for (const [gateName, label] of GATE_ORDER) {
    const command = resolveProfileCommand(commands, gateName);
    if (!command || typeof command !== "string" || command.trim().length === 0) {
      gateRows.push([label, "NOT-CONFIGURED", "no profile command"]);
      continue;
    }

    if (dryRun) {
      gateRows.push([label, "PLAN", command]);
      continue;
    }

    const result = runShellCapture(command);
    if (result.error) {
      gateRows.push([label, "FAIL", result.error.message]);
      overall = "FAIL";
    } else if (result.status === 0) {
      gateRows.push([label, "PASS", command]);
    } else {
      const tail = (result.stderr || result.stdout || "")
        .trim()
        .split(/\r?\n/)
        .slice(-3)
        .join(" | ");
      gateRows.push([label, "FAIL", tail || `exit ${result.status}`]);
      overall = "FAIL";
    }
  }
  const passedGates = gateRows.filter((row) => row[1] === "PASS").length - 0;
  const configuredGates = gateRows.length - 1;
  results.push([
    "Quality gates",
    gateRows.slice(1).some((row) => row[1] === "FAIL") ? "FAIL" : "OK",
    `${passedGates} passed, ${configuredGates} evaluated (unconfigured gates report NOT-CONFIGURED)`
  ]);
  printTable(gateRows);

  // 5. Detect unexpected modifications caused by verification commands.
  const treeAfter = sortedStatusLines(getWorkingTreeStatus());
  const sideEffects = treeAfter.filter((line) => !treeBefore.includes(line));
  if (sideEffects.length > 0) {
    results.push([
      "Side effects",
      "WARNING",
      `${sideEffects.length} path(s) changed by verification commands`
    ]);
    for (const line of sideEffects) {
      console.log(`  ! ${line}`);
    }
  } else {
    results.push([
      "Side effects",
      "PASS",
      "no working-tree changes from verification"
    ]);
  }

  printTable([["Check", "Result", "Detail"], ...results]);
  logSection(`Preflight summary: ${overall === "FAIL" ? "FAIL" : "PASS"}`);
  process.exit(overall === "FAIL" ? 1 : 0);
}

if (require.main === module) {
  main();
} else {
  module.exports = { main };
}
