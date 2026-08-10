#!/usr/bin/env node

const { spawnSync } = require("child_process");
const { resolveRepoRoot } = require("./tctbp-runtime");

const repoRoot = resolveRepoRoot();

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ── Raw git execution ──────────────────────────────────────────────────────

function runGitResult(args) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runGitCapture(args, description, allowEmpty = false) {
  const result = runGitResult(args);

  if (result.error) {
    fail(`${description} failed: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    fail(`${description} failed${stderr ? `: ${stderr}` : "."}`);
  }

  const stdout = (result.stdout || "").trim();

  if (!allowEmpty && !stdout) {
    fail(`${description} returned no output.`);
  }

  return stdout;
}

function tryGitCapture(args) {
  const result = runGitResult(args);

  if (result.error) {
    return null;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    return null;
  }

  return (result.stdout || "").trim();
}

function runMutableGit(args, dryRun, description, options = {}) {
  const { readOnly = false } = options;

  if (dryRun && !readOnly) {
    console.log(`[dry-run] ${description}: git ${args.join(" ")}`);
    return;
  }

  const result = spawnSync("git", args, {
    cwd: repoRoot,
    stdio: "inherit"
  });

  if (result.error) {
    fail(`${description} failed: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    fail(`${description} failed with exit code ${result.status}.`);
  }
}

function runCommand(command, args, dryRun, description, options = {}) {
  const { cwd = repoRoot, shell = process.platform === "win32" } = options;

  if (dryRun) {
    console.log(`[dry-run] ${description}: ${command} ${args.join(" ")}`);
    return;
  }

  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell
  });

  if (result.error) {
    fail(`${description} failed: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    fail(`${description} failed with exit code ${result.status}.`);
  }
}

function runShellCommand(command, dryRun, description, options = {}) {
  const { cwd = repoRoot } = options;

  if (dryRun) {
    console.log(`[dry-run] ${description}: ${command}`);
    return;
  }

  const result = spawnSync(command, {
    cwd,
    stdio: "inherit",
    shell: true
  });

  if (result.error) {
    fail(`${description} failed: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    fail(`${description} failed with exit code ${result.status}.`);
  }
}

// ── Fetch and branch inspection ─────────────────────────────────────────────

function fetchOrigin(dryRun, includeTags = false) {
  const args = includeTags ? ["fetch", "--prune", "--tags", "origin"] : ["fetch", "--prune", "origin"];
  runMutableGit(args, dryRun, "Fetch origin before workflow preflight");
}

function getCurrentBranch() {
  return runGitCapture(["rev-parse", "--abbrev-ref", "HEAD"], "Determine the current branch");
}

function getHeadCommit(short = false) {
  return runGitCapture(short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"], "Resolve HEAD commit");
}

function getHeadSummary() {
  return runGitCapture(["log", "-1", "--oneline", "--decorate=short", "--no-color", "HEAD"], "Resolve HEAD summary", true) || "unknown";
}

function getWorkingTreeStatus() {
  return runGitCapture(["status", "--porcelain", "--untracked-files=all"], "Inspect working tree state", true);
}

function getDefaultRemote() {
  const remotesOutput = runGitCapture(["remote"], "List configured remotes", true);
  const remotes = remotesOutput
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (remotes.includes("origin")) {
    return "origin";
  }

  if (remotes.length > 0) {
    return remotes[0];
  }

  fail("No git remotes are configured.");
}

// ── Ref and branch existence ────────────────────────────────────────────────

function gitRefExists(refName) {
  const result = spawnSync("git", ["rev-parse", "--verify", refName], {
    cwd: repoRoot,
    stdio: "ignore"
  });

  return result.status === 0;
}

function gitLocalBranchExists(branchName) {
  return gitRefExists(`refs/heads/${branchName}`);
}

function gitRemoteBranchExists(branchName) {
  return gitRefExists(`refs/remotes/origin/${branchName}`);
}

function gitRemoteTagExists(tagName) {
  const result = spawnSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tagName}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    fail(`Inspect remote release tags failed: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    fail(`Inspect remote release tags failed${stderr ? `: ${stderr}` : "."}`);
  }

  return Boolean((result.stdout || "").trim());
}

function getShortRef(refName) {
  if (!gitRefExists(refName)) {
    return null;
  }

  return runGitCapture(["rev-parse", "--short", refName], `Resolve ${refName}`);
}

// ── Sync state and operation detection ──────────────────────────────────────

function inspectBranchSyncState(branchName, options = {}) {
  const remoteExists = options.remoteExists === undefined ? gitRemoteBranchExists(branchName) : options.remoteExists;

  if (!remoteExists) {
    return {
      ahead: 0,
      behind: 0,
      diverged: false
    };
  }

  const localRef = options.localRef || `refs/heads/${branchName}`;
  const output = runGitCapture(
    ["rev-list", "--left-right", "--count", `${localRef}...refs/remotes/origin/${branchName}`],
    `Inspect sync state for ${branchName}`
  );
  const parts = output.split(/\s+/).map((value) => Number.parseInt(value, 10));

  if (parts.length !== 2 || parts.some((value) => Number.isNaN(value))) {
    fail(`Could not parse branch sync state output for ${branchName}: '${output}'.`);
  }

  return {
    ahead: parts[0],
    behind: parts[1],
    diverged: parts[0] > 0 && parts[1] > 0
  };
}

function stopIfBehindOrDiverged(remoteState, remoteBranchLabel, prefix = "Workflow") {
  if (remoteState.diverged) {
    fail(`${prefix} stopped because the local branch has diverged from ${remoteBranchLabel}.`);
  }

  if (remoteState.behind > 0) {
    fail(`${prefix} stopped because the local branch is behind ${remoteBranchLabel} by ${remoteState.behind} commit(s).`);
  }
}

function detectGitOperationState() {
  const path = require("path");
  const fs = require("fs");
  const gitDirRelative = runGitCapture(["rev-parse", "--git-dir"], "Resolve git directory", true) || ".git";
  const gitDir = path.resolve(repoRoot, gitDirRelative);
  const states = [];

  if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    states.push("merge");
  }

  if (fs.existsSync(path.join(gitDir, "rebase-apply")) || fs.existsSync(path.join(gitDir, "rebase-merge"))) {
    states.push("rebase");
  }

  if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
    states.push("cherry-pick");
  }

  if (fs.existsSync(path.join(gitDir, "REVERT_HEAD"))) {
    states.push("revert");
  }

  return states;
}

// ── Status classification ──────────────────────────────────────────────────

function classifyStatusLine(line) {
  const code = line.slice(0, 2);

  if (code === "??") {
    return "untracked";
  }

  const significantCode = code.replace(/\s/g, "");

  if (significantCode.includes("R")) {
    return "renamed";
  }

  if (significantCode.includes("C")) {
    return "copied";
  }

  if (significantCode.includes("D")) {
    return "deleted";
  }

  if (significantCode.includes("A")) {
    return "added";
  }

  if (significantCode.includes("M")) {
    return "modified";
  }

  return "other";
}

module.exports = {
  classifyStatusLine,
  detectGitOperationState,
  fetchOrigin,
  getCurrentBranch,
  getDefaultRemote,
  getHeadCommit,
  getHeadSummary,
  getShortRef,
  getWorkingTreeStatus,
  gitLocalBranchExists,
  gitRefExists,
  gitRemoteBranchExists,
  gitRemoteTagExists,
  inspectBranchSyncState,
  runCommand,
  runGitCapture,
  runGitResult,
  runMutableGit,
  runShellCommand,
  stopIfBehindOrDiverged,
  tryGitCapture
};
