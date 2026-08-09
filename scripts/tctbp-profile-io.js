#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { resolvePolicyPath, resolveRepoRoot } = require("./tctbp-runtime");

const repoRoot = resolveRepoRoot();
const policyPath = resolvePolicyPath(repoRoot);

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ── Policy loading ──────────────────────────────────────────────────────────

function loadPolicy() {
  try {
    return JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    fail(`Could not read ${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Path resolution ─────────────────────────────────────────────────────────

function resolveRepoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

// ── JSON file I/O ───────────────────────────────────────────────────────────

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function maybeReadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function updateJsonFileRaw(filePath, replacements) {
  let content = fs.readFileSync(filePath, "utf8");

  for (const [needle, replacementValue] of Object.entries(replacements)) {
    const pattern = new RegExp(escapeRegExp(needle), "g");
    content = content.replace(pattern, replacementValue);
  }

  fs.writeFileSync(filePath, content, "utf8");
}

// ── Version reading ─────────────────────────────────────────────────────────

function readVersionSource(config) {
  const relativePath =
    config && config.profile && config.profile.versioning && typeof config.profile.versioning.sourceOfTruth === "string"
      ? config.profile.versioning.sourceOfTruth
      : null;

  if (!relativePath) {
    return {
      path: "n/a",
      version: "n/a"
    };
  }

  const absolutePath = resolveRepoPath(relativePath);

  // Try JSON first (package.json, etc.)
  const json = maybeReadJsonFile(absolutePath);
  if (json && typeof json.version === "string") {
    return {
      path: relativePath,
      version: json.version
    };
  }

  // Fall back to plain-text version file (VERSION, etc.)
  try {
    const text = fs.readFileSync(absolutePath, "utf8").trim();
    if (text.length > 0 && text.length < 64) {
      return {
        path: relativePath,
        version: text.split(/\r?\n/)[0].trim()
      };
    }
  } catch (_error) {
    // File doesn't exist or can't be read; fall through.
  }

  return {
    path: relativePath,
    version: "unknown"
  };
}

// ── Semver ──────────────────────────────────────────────────────────────────

function parseSemVer(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);

  if (!match) {
    fail(`Unsupported version format '${version}' (expected X.Y.Z).`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
}

function stepSemVer(version, bump) {
  const parsed = parseSemVer(version);

  if (bump === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  if (bump === "major") {
    return `${parsed.major + 1}.0.0`;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

// ── Release tag resolution ──────────────────────────────────────────────────

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getReleaseTagPattern(config) {
  const configuredFormat =
    config && config.profile && config.profile.versioning && typeof config.profile.versioning.tagFormat === "string"
      ? config.profile.versioning.tagFormat
      : "v{version}";
  const patternSource = configuredFormat
    .split("{version}")
    .map((segment) => escapeRegExp(segment))
    .join("\\d+\\.\\d+\\.\\d+");

  return new RegExp(`^${patternSource}$`);
}

function getReleaseTagGlob(config) {
  const configuredFormat =
    config && config.profile && config.profile.versioning && typeof config.profile.versioning.tagFormat === "string"
      ? config.profile.versioning.tagFormat
      : "v{version}";

  return configuredFormat.replace("{version}", "*");
}

// ── Shared target resolution ────────────────────────────────────────────────

function resolveTarget(targets, targetArg) {
  const normalized = String(targetArg).toLowerCase();

  for (const [key, target] of Object.entries(targets)) {
    const names = [key, ...(target.aliases || [])].map((value) => String(value).toLowerCase());

    if (names.includes(normalized)) {
      return { key, target };
    }
  }

  return null;
}

module.exports = {
  getReleaseTagGlob,
  getReleaseTagPattern,
  loadPolicy,
  maybeReadJsonFile,
  parseSemVer,
  policyPath,
  readJsonFile,
  readVersionSource,
  repoRoot,
  resolveRepoPath,
  resolveTarget,
  stepSemVer,
  updateJsonFileRaw
};
