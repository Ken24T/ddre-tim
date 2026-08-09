#!/usr/bin/env node

const path = require("path");
const { spawnSync } = require("child_process");
const { fail } = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printUsage(0);
}

main(options);

function main(cliOptions) {
  const scriptPath = path.join(__dirname, "version-status.mjs");
  const passthroughArgs = [];

  if (cliOptions.strict) {
    passthroughArgs.push("--strict");
  }

  if (cliOptions.requiredEnvironment) {
    passthroughArgs.push("--required-environment", cliOptions.requiredEnvironment);
  }

  const result = spawnSync(process.execPath, [scriptPath, ...passthroughArgs], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    fail(`Version runner failed: ${result.error.message}`);
  }

  process.exit(typeof result.status === "number" ? result.status : 1);
}

function parseArgs(argv) {
  const parsed = {
    list: false,
    strict: false,
    requiredEnvironment: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    if (arg === "--strict") {
      parsed.strict = true;
      continue;
    }

    if (arg === "--required-environment") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        fail("--required-environment requires a value.");
      }
      parsed.requiredEnvironment = value;
      continue;
    }

    fail(`Unknown option '${arg}'.`);
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-version.js [--strict] [--required-environment <environment>] [--list]");
  process.exit(exitCode);
}
