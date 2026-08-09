#!/usr/bin/env node

const path = require("path");
const { resolveRepoRoot, resolveRuntimeCwd } = require("./tctbp-runtime");
const { runCommand, runShellCommand } = require("./tctbp-git-ops");
const { maybeReadJsonFile } = require("./tctbp-profile-io");
const { fail } = require("./tctbp-output");

const repoRoot = resolveRepoRoot();
const runtimeCwd = resolveRuntimeCwd(repoRoot);

// ── Verification gates (profile-driven) ─────────────────────────────────────

function runVerificationGates(config, dryRun, descriptionPrefix = "Verification") {
  const commands = config.profile && config.profile.commands ? config.profile.commands : {};
  const configuredBlockingCommands =
    config.profile && config.profile.verification && Array.isArray(config.profile.verification.blockingCommands)
      ? config.profile.verification.blockingCommands
      : ["format", "test", "lint"];
  const labelMap = {
    format: "Format",
    test: "Test",
    lint: "Lint",
    build: "Build",
    "release-build": "Release build"
  };
  const verificationCommands = configuredBlockingCommands
    .map((gateName) => [labelMap[gateName] || gateName, commands[gateName]])
    .filter(([, command]) => typeof command === "string" && command.trim().length > 0);

  if (verificationCommands.length === 0) {
    fail("No verification commands are configured in .github/TCTBP.json.");
  }

  for (const [label, command] of verificationCommands) {
    runShellCommand(command, dryRun, `${descriptionPrefix}: ${label}`);
  }
}

// ── Build gate (deploy-configured) ──────────────────────────────────────────

function runBuildGate(config, dryRun, description = "Runtime build gate") {
  const buildCommand = config.deploy && typeof config.deploy.buildCommand === "string" ? config.deploy.buildCommand : null;

  if (!buildCommand) {
    return; // No build command configured — not an error for template repos.
  }

  runShellCommand(buildCommand, dryRun, description);
}

// ── Ship gates (package.json driven) ────────────────────────────────────────

function runShipGates(dryRun) {
  const packageJson = maybeReadJsonFile(path.join(runtimeCwd, "package.json"));

  if (!packageJson || !packageJson.scripts) {
    fail(`Could not read ${path.join(runtimeCwd, "package.json")} for ship gates.`);
  }

  const commands = [];

  if (packageJson.scripts["format:check"]) {
    commands.push(["npm", ["run", "format:check"], "Format gate"]);
  }

  if (packageJson.scripts.lint) {
    commands.push(["npm", ["run", "lint"], "Lint gate"]);
  }

  if (packageJson.scripts.typecheck) {
    commands.push(["npm", ["run", "typecheck"], "Typecheck gate"]);
  }

  if (packageJson.scripts.test) {
    commands.push(["npm", ["test"], "Test gate"]);
  }

  if (packageJson.scripts.build) {
    commands.push(["npm", ["run", "build"], "Build gate"]);
  }

  if (commands.length === 0) {
    fail("No ship gates are configured in the local runtime package.json.");
  }

  for (const [command, args, label] of commands) {
    runCommand(command, args, dryRun, label, { cwd: runtimeCwd });
  }
}

module.exports = {
  runBuildGate,
  runShipGates,
  runVerificationGates
};
