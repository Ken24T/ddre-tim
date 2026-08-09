"use strict";

const { spawnSync } = require("child_process");

function runGit(repoRoot, args, description) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    throw new Error(`${description} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${description} failed${detail ? `: ${detail}` : "."}`);
  }

  return String(result.stdout || "").trim();
}

function normaliseObjectId(value, label) {
  const objectId = String(value || "").trim().toLowerCase();

  if (!/^[0-9a-f]{40,64}$/.test(objectId)) {
    throw new Error(`${label} must be a full Git object ID.`);
  }

  return objectId;
}

function resolveCandidate({ repoRoot, ref, label = ref }) {
  const commit = normaliseObjectId(
    runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`], `Resolve ${label} commit`),
    `${label} commit`
  );
  const tree = normaliseObjectId(
    runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{tree}`], `Resolve ${label} tree`),
    `${label} tree`
  );

  return { ref, label, commit, tree };
}

function assertCandidate({
  repoRoot,
  ref,
  expectedCommit = null,
  expectedTree = null,
  label = ref
}) {
  if (!expectedCommit && !expectedTree) {
    throw new Error(`Cannot verify ${label} without an expected commit or tree.`);
  }

  const actual = resolveCandidate({ repoRoot, ref, label });

  if (expectedCommit && actual.commit !== normaliseObjectId(expectedCommit, `Expected ${label} commit`)) {
    throw new Error(`${label} moved: expected commit ${expectedCommit}, found ${actual.commit}.`);
  }

  if (expectedTree && actual.tree !== normaliseObjectId(expectedTree, `Expected ${label} tree`)) {
    throw new Error(`${label} content changed: expected tree ${expectedTree}, found ${actual.tree}.`);
  }

  return actual;
}

function captureSyncedBranchCandidate({ repoRoot, branch, remote = "origin" }) {
  const local = resolveCandidate({
    repoRoot,
    ref: `refs/heads/${branch}`,
    label: `local ${branch}`
  });
  const remoteCandidate = resolveCandidate({
    repoRoot,
    ref: `refs/remotes/${remote}/${branch}`,
    label: `${remote}/${branch}`
  });

  if (local.commit !== remoteCandidate.commit || local.tree !== remoteCandidate.tree) {
    throw new Error(
      `Candidate branch ${branch} is not exactly synced with ${remote}/${branch}: ` +
        `local ${local.commit} (${local.tree}), remote ${remoteCandidate.commit} (${remoteCandidate.tree}).`
    );
  }

  return {
    branch,
    remote,
    commit: local.commit,
    tree: local.tree
  };
}

function assertSyncedBranchCandidate({
  repoRoot,
  branch,
  expectedCommit,
  expectedTree,
  remote = "origin"
}) {
  const candidate = captureSyncedBranchCandidate({ repoRoot, branch, remote });

  if (candidate.commit !== normaliseObjectId(expectedCommit, `Expected ${branch} commit`)) {
    throw new Error(`Candidate branch ${branch} drifted: expected commit ${expectedCommit}, found ${candidate.commit}.`);
  }

  if (candidate.tree !== normaliseObjectId(expectedTree, `Expected ${branch} tree`)) {
    throw new Error(`Candidate branch ${branch} content drifted: expected tree ${expectedTree}, found ${candidate.tree}.`);
  }

  return candidate;
}

function assertIndexCandidateTree({ repoRoot, expectedTree, label = "Staged candidate" }) {
  const actualTree = normaliseObjectId(
    runGit(repoRoot, ["write-tree"], `Resolve ${label} tree`),
    `${label} tree`
  );
  const normalisedExpected = normaliseObjectId(expectedTree, `Expected ${label} tree`);

  if (actualTree !== normalisedExpected) {
    throw new Error(
      `${label} does not match the verified preflight tree: expected ${normalisedExpected}, found ${actualTree}.`
    );
  }

  return actualTree;
}

module.exports = {
  assertCandidate,
  assertIndexCandidateTree,
  assertSyncedBranchCandidate,
  captureSyncedBranchCandidate,
  normaliseObjectId,
  resolveCandidate
};
