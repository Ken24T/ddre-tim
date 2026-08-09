#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  evaluateVersionStatus,
  formatVersionStatusSummary,
  parseVersionStatusArgs,
  resolveVersionStatusPolicy,
} from "./version-status-policy.mjs";

function runGit(repoRoot, args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error || (!allowFailure && result.status !== 0)) {
    return null;
  }

  return String(result.stdout || "").trim();
}

function readPolicy(repoRoot) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, ".github", "TCTBP.json"), "utf8"));
  } catch {
    return {};
  }
}

function getRepoRoot() {
  return runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

function getBranchNames(config) {
  const branchModel = config.branchModel || {};
  const strategy = branchModel.strategy || "simple";
  const strategyConfig = branchModel.strategies?.[strategy] || branchModel;
  return [...new Set([
    strategyConfig.workingBranch,
    strategyConfig.stagingBranch,
    strategyConfig.reviewBranch,
    strategyConfig.productionBranch || config.project?.defaultBranch || "main",
  ].filter(Boolean))];
}

function getVersionFiles(config) {
  const files = Array.isArray(config.project?.versionFiles) ? config.project.versionFiles : ["package.json"];
  return files.filter((value) => typeof value === "string" && value.trim());
}

function parseVersionContent(content, filePath) {
  const trimmed = String(content || "").trim();
  if (!trimmed) return null;

  if (filePath.endsWith(".json") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed).version || null;
    } catch {
      return null;
    }
  }

  return trimmed.split(/\r?\n/, 1)[0].trim() || null;
}

function getVersionAtRef(repoRoot, ref, config) {
  for (const versionFile of getVersionFiles(config)) {
    const content = runGit(repoRoot, ["show", `${ref}:${versionFile}`]);
    const version = parseVersionContent(content, versionFile);
    if (version) return version;
  }
  return null;
}

function getRuntimeState(repoRoot, config) {
  const configuredPath = config.versionStatus?.runtimeStatePath;
  if (typeof configuredPath !== "string" || !configuredPath.trim()) return null;

  const runtimePath = path.resolve(repoRoot, configuredPath);
  if (!existsSync(runtimePath)) return null;

  try {
    return JSON.parse(readFileSync(runtimePath, "utf8"));
  } catch {
    return null;
  }
}

function getEnvironmentRuntime(runtimeState, environment) {
  return runtimeState?.[environment] || runtimeState?.environments?.[environment] || runtimeState?.targets?.[environment] || null;
}

function printTable(headers, rows) {
  console.log(`| ${headers.join(" | ")} |`);
  console.log(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
}

function main(argv = process.argv.slice(2)) {
  const repoRoot = getRepoRoot();
  if (!repoRoot) throw new Error("Not inside a Git repository.");

  const config = readPolicy(repoRoot);
  const policy = resolveVersionStatusPolicy(config);
  const options = parseVersionStatusArgs(argv, policy);
  const branchNames = getBranchNames(config);
  const branchToEnvironment = Object.fromEntries(
    Object.entries(policy.environmentToBranch).map(([environment, branch]) => [branch, environment]),
  );
  const runtimeState = getRuntimeState(repoRoot, config);
  const branchRows = [];
  const runtimeRows = [];
  const branchChecks = [];
  const runtimeChecks = [];

  for (const branch of branchNames) {
    const localCommit = runGit(repoRoot, ["rev-parse", "--short", `refs/heads/${branch}`], true) || "missing";
    const remoteCommit = runGit(repoRoot, ["rev-parse", "--short", `refs/remotes/origin/${branch}`], true) || "missing";
    const version = getVersionAtRef(repoRoot, `refs/heads/${branch}`, config) || "unknown";
    const inSync = localCommit !== "missing" && localCommit === remoteCommit;
    const environment = branchToEnvironment[branch] || branch;

    branchChecks.push({ branch, inSync });
    branchRows.push([branch, environment, version, localCommit, remoteCommit, inSync ? "yes" : "no"]);

    const runtime = getEnvironmentRuntime(runtimeState, environment);
    if (!runtimeState || !runtime) continue;

    const deployedCommit = runtime.commit || "unknown";
    const deployedVersion = runtime.version || (runtime.commit ? getVersionAtRef(repoRoot, runtime.commit, config) : null) || "unknown";
    const commitAligned = runtime.commit
      ? localCommit !== "missing" && (runtime.commit === localCommit || runtime.commit.startsWith(localCommit))
      : false;
    const versionAligned = deployedVersion !== "unknown" && deployedVersion === version;

    runtimeChecks.push({ environment, versionAligned, commitAligned });
    runtimeRows.push([
      environment,
      version,
      localCommit,
      deployedCommit.slice(0, 12),
      deployedVersion,
      runtime.deployedAt || "unknown",
      versionAligned ? "yes" : "no",
      commitAligned ? "yes" : "no",
    ]);
  }

  const evaluation = evaluateVersionStatus({
    branchChecks,
    runtimeChecks,
    requiredEnvironment: options.requiredEnvironment,
    policy,
  });

  console.log("Branch Version And Sync");
  printTable(["Branch", "Environment", "Version", "Local", "Origin", "In Sync"], branchRows);

  if (runtimeRows.length > 0) {
    console.log("\nRuntime Deployment Alignment");
    printTable(
      ["Environment", "Branch Version", "Branch Commit", "Deployed Commit", "Deployed Version", "Deployed At", "Version Aligned", "Commit Aligned"],
      runtimeRows,
    );
  }

  if (options.requiredEnvironment) {
    console.log(`\nRequired deploy scope: ${options.requiredEnvironment} (branch ${policy.environmentToBranch[options.requiredEnvironment]}).`);
    console.log("Mismatches outside this scope are advisory for this deploy.");
  }

  console.log(`\n${formatVersionStatusSummary(evaluation)}`);
  if (evaluation.advisoryMismatches.length > 0 && options.requiredEnvironment) {
    console.log("Advisory mismatches:");
    for (const mismatch of evaluation.advisoryMismatches) {
      console.log(`- ${mismatch.scope} ${mismatch.name}: ${mismatch.reasons.join("; ")}`);
    }
  }

  if (options.strict && !evaluation.requiredAligned) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`version-status failed: ${error.message}`);
  process.exitCode = 2;
}
