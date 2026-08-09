"use strict";

const DEFAULT_ENVIRONMENT_TO_BRANCH = Object.freeze({
  development: "development",
  staging: "staging",
  production: "main",
});

const DEFAULT_ENVIRONMENT_ALIASES = Object.freeze({
  dev: "development",
  development: "development",
  staging: "staging",
  review: "staging",
  prod: "production",
  production: "production",
  main: "production",
});

export function resolveVersionStatusPolicy(config = {}) {
  const configured = config.versionStatus || {};
  const environmentToBranch = {
    ...DEFAULT_ENVIRONMENT_TO_BRANCH,
    ...(configured.environmentToBranch || {}),
  };
  const environmentAliases = {
    ...DEFAULT_ENVIRONMENT_ALIASES,
    ...(configured.environmentAliases || {}),
  };

  return { environmentToBranch, environmentAliases };
}

export function normaliseRequiredEnvironment(value, policy = resolveVersionStatusPolicy()) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const normalised = policy.environmentAliases[String(value).trim().toLowerCase()];
  if (!normalised || !policy.environmentToBranch[normalised]) {
    throw new Error(`Unknown required environment '${value}'.`);
  }

  return normalised;
}

export function parseVersionStatusArgs(argv, policy = resolveVersionStatusPolicy()) {
  const parsed = { strict: false, requiredEnvironment: null };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--strict") {
      parsed.strict = true;
      continue;
    }

    if (argument === "--required-environment") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--required-environment requires a value.");
      }
      parsed.requiredEnvironment = normaliseRequiredEnvironment(value, policy);
      index += 1;
      continue;
    }

    throw new Error(`Unknown version-status option '${argument}'.`);
  }

  return parsed;
}

export function evaluateVersionStatus({
  branchChecks = [],
  runtimeChecks = [],
  requiredEnvironment = null,
  policy = resolveVersionStatusPolicy(),
}) {
  const required = normaliseRequiredEnvironment(requiredEnvironment, policy);
  const mismatches = [];

  for (const check of branchChecks) {
    if (!check.inSync) {
      mismatches.push({
        scope: "branch",
        name: check.branch,
        reasons: ["local and origin refs are not aligned"],
      });
    }
  }

  for (const check of runtimeChecks) {
    const reasons = [];
    if (!check.versionAligned) reasons.push("deployed version does not match the branch version");
    if (!check.commitAligned) reasons.push("deployed commit does not match the branch commit");
    if (reasons.length > 0) mismatches.push({ scope: "runtime", name: check.environment, reasons });
  }

  const requiredBranch = required ? policy.environmentToBranch[required] : null;
  const blockingMismatches = required
    ? mismatches.filter(
        (item) =>
          (item.scope === "branch" && item.name === requiredBranch) ||
          (item.scope === "runtime" && item.name === required),
      )
    : [...mismatches];
  const advisoryMismatches = mismatches.filter((item) => !blockingMismatches.includes(item));

  return {
    requiredEnvironment: required,
    mismatches,
    blockingMismatches,
    advisoryMismatches,
    allAligned: mismatches.length === 0,
    requiredAligned: blockingMismatches.length === 0,
  };
}

export function formatVersionStatusSummary(evaluation) {
  if (evaluation.allAligned) return "Status: all branch and runtime checks are aligned.";
  if (!evaluation.requiredEnvironment) {
    return `Status: ${evaluation.blockingMismatches.length} blocking mismatch(es) detected.`;
  }
  if (!evaluation.requiredAligned) {
    return (
      `Status: required environment '${evaluation.requiredEnvironment}' has ` +
      `${evaluation.blockingMismatches.length} blocking mismatch(es); ` +
      `${evaluation.advisoryMismatches.length} advisory mismatch(es) remain elsewhere.`
    );
  }
  return (
    `Status: required environment '${evaluation.requiredEnvironment}' is aligned; ` +
    `${evaluation.advisoryMismatches.length} advisory mismatch(es) remain elsewhere.`
  );
}
