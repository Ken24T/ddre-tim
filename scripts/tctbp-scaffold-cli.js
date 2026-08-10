#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ── Interview ───────────────────────────────────────────────────────────────

async function interview(cliOptions) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

  console.log("TCTBP-Web Project Scaffold\n");

  const projectName = cliOptions.name || await ask("Project name: ");
  const targetPath = cliOptions.target || await ask("Target directory (absolute path): ");
  const workingBranch = cliOptions.working || await ask("Working branch name [development]: ") || "development";
  const branchStrategy = cliOptions.strategy || await ask("Branch strategy: staged (development→staging→main) or simple (main only) [staged]: ") || "staged";
  const framework = cliOptions.framework || await ask("Framework: vite (React+TS), next, vue, svelte, or none [vite]: ") || "vite";
  const deployTarget = cliOptions.deploy || await ask("Deploy target: Vercel, Netlify, Cloudflare Pages, Docker, or none yet [none yet]: ") || "none yet";
  const testFramework = cliOptions.test || await ask("Test framework: vitest, jest, or none [vitest]: ") || "vitest";

  rl.close();

  return {
    projectName: projectName.trim(),
    targetPath: path.resolve(targetPath.trim()),
    workingBranch: workingBranch.trim() || "development",
    branchStrategy: branchStrategy.trim() || "staged",
    framework: framework.trim() || "vite",
    deployTarget: deployTarget.trim() || "none yet",
    testFramework: testFramework.trim() || "vitest",
  };
}

function getDefaultAnswers() {
  return {
    projectName: "my-web-app",
    targetPath: path.resolve(process.cwd(), "my-web-app"),
    workingBranch: "development",
    branchStrategy: "staged",
    framework: "vite",
    deployTarget: "none yet",
    testFramework: "vitest",
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateAnswers(answers) {
  if (!answers.projectName || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(answers.projectName)) {
    fail("Project name must be a valid npm package name (lowercase, hyphens, no spaces, start and end with alphanumeric).");
  }

  if (!answers.targetPath || !path.isAbsolute(answers.targetPath)) {
    fail("Target path must be an absolute path.");
  }

  if (fs.existsSync(answers.targetPath)) {
    const contents = fs.readdirSync(answers.targetPath);
    if (contents.length > 0) {
      fail(`Target directory is not empty (${contents.length} item(s)). Use reconcile-tctbp for existing projects, or choose an empty directory.`);
    }
  }

  if (answers.workingBranch === "main" || answers.workingBranch === "staging") {
    fail(`Working branch cannot be '${answers.workingBranch}'. Choose a different name.`);
  }

  if (!["staged", "simple"].includes(answers.branchStrategy)) {
    fail("Branch strategy must be 'staged' or 'simple'.");
  }

  if (!["vite", "none"].includes(answers.framework)) {
    fail("Framework must be 'vite' or 'none'.");
  }

  const validDeployTargets = ["vercel", "netlify", "cloudflare pages", "docker", "none yet"];
  if (!validDeployTargets.includes(answers.deployTarget.toLowerCase())) {
    fail(`Deploy target must be one of: ${validDeployTargets.join(", ")}.`);
  }

  if (!["vitest", "jest", "none"].includes(answers.testFramework)) {
    fail("Test framework must be 'vitest', 'jest', or 'none'.");
  }
}

// ── CLI parsing ─────────────────────────────────────────────────────────────

function parseArgs(args) {
  const result = {
    name: null,
    target: null,
    working: null,
    strategy: null,
    deploy: null,
    test: null,
    defaults: false,
    dryRun: false,
    list: false,
    passthroughArgs: []
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--name": result.name = args[++i]; break;
      case "--target": result.target = args[++i]; break;
      case "--working": result.working = args[++i]; break;
      case "--strategy": result.strategy = args[++i]; break;
      case "--deploy": result.deploy = args[++i]; break;
      case "--test": result.test = args[++i]; break;
      case "--defaults": result.defaults = true; break;
      case "--dry-run": result.dryRun = true; break;
      case "--list": result.list = true; break;
      default: result.passthroughArgs.push(arg);
    }
  }

  return result;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-scaffold.js [--name <name>] [--target <path>] [--working <branch>] [--strategy staged|simple] [--deploy <target>] [--test vitest|jest|none] [--defaults] [--dry-run] [--list]");
  process.exit(exitCode);
}

module.exports = {
  getDefaultAnswers,
  interview,
  parseArgs,
  printUsage,
  validateAnswers
};
