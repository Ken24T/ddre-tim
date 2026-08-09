#!/usr/bin/env node

const path = require("path");
const fs = require("fs");

function resolveRepoRoot() {
  if (typeof process.env.TCTBP_REPO_ROOT === "string" && process.env.TCTBP_REPO_ROOT.trim().length > 0) {
    return path.resolve(process.env.TCTBP_REPO_ROOT);
  }

  return path.resolve(__dirname, "..");
}

function resolvePolicyPath(repoRoot) {
  return path.join(repoRoot, ".github", "TCTBP.json");
}

function resolveRuntimeCwd(repoRoot) {
  const policyPath = resolvePolicyPath(repoRoot);

  try {
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    const configured = policy && policy.profile && policy.profile.runtimeCwd;

    if (typeof configured === "string" && configured.trim().length > 0) {
      return path.resolve(repoRoot, configured);
    }
  } catch (_error) {
    // Policy not yet readable; fall back to repo root.
  }

  return repoRoot;
}

module.exports = {
  resolvePolicyPath,
  resolveRepoRoot,
  resolveRuntimeCwd
};
