#!/usr/bin/env node

const { spawnSync } = require("child_process");
const { resolveRepoRoot, resolveRuntimeCwd, resolvePolicyPath } = require("./tctbp-runtime");

const repoRoot = resolveRepoRoot();
const runtimeCwd = resolveRuntimeCwd(repoRoot);

const GATE_LABEL = {
  format: "Format",
  test: "Test",
  lint: "Lint",
  build: "Build",
  "release-build": "Release build"
};

// Hardcoded npm fallbacks used when the profile does not specify a command.
const NPM_FALLBACK = {
  format: ["npm", ["run", "format:check"]],
  test: ["npm", ["test"]],
  lint: ["npm", ["run", "lint"]],
  build: ["npm", ["run", "build"]],
  "release-build": ["npm", ["run", "build"]]
};

const args = process.argv.slice(2);
const gate = args[0];
const dryRun = args.includes("--dry-run");
const listOnly = args.includes("--list");

if (!gate || listOnly) {
  printUsage(listOnly ? 0 : 1);
}

if (!GATE_LABEL[gate]) {
  console.error(`Unknown gate '${gate}'.`);
  printUsage(1);
}

const policy = loadPolicy();
const profileCommand = (policy.profile && policy.profile.commands && policy.profile.commands[gate]) || null;

if (profileCommand && typeof profileCommand === "string" && profileCommand.trim().length > 0) {
  // Profile-driven gate: run the configured shell command.
  if (dryRun) {
    console.log(`[dry-run] ${GATE_LABEL[gate]} gate (profile): ${profileCommand}`);
    console.log(runtimeCwd);
    process.exit(0);
  }

  const result = spawnSync(profileCommand, {
    cwd: runtimeCwd,
    stdio: "inherit",
    shell: true
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status === null ? 1 : result.status);
}

// Fallback: use hardcoded npm command when the profile does not specify one.
const [command, commandArgs] = NPM_FALLBACK[gate];

if (dryRun) {
  console.log(`[dry-run] ${GATE_LABEL[gate]} gate (npm fallback): ${command} ${commandArgs.join(" ")}`);
  console.log(runtimeCwd);
  process.exit(0);
}

const result = spawnSync(command, commandArgs, {
  cwd: runtimeCwd,
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);

function loadPolicy() {
  try {
    return JSON.parse(require("fs").readFileSync(resolvePolicyPath(repoRoot), "utf8"));
  } catch (_error) {
    // Policy not readable; fall through to npm defaults.
    return {};
  }
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-gate.js <format|test|lint|build|release-build> [--dry-run] [--list]");
  process.exit(exitCode);
}
