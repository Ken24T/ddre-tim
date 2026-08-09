"use strict";

const { spawnSync } = require("child_process");

function runGit(repoRoot, args) {
  return spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function commandDetail(result) {
  return String(result.stderr || result.stdout || "").trim();
}

function requireGitSuccess(result, description) {
  if (result.error) {
    throw new Error(`${description} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = commandDetail(result);
    throw new Error(`${description} failed${detail ? `: ${detail}` : "."}`);
  }
  return String(result.stdout || "").trim();
}

function inspectMergePreflight({ repoRoot, targetRef, sourceRef }) {
  const result = runGit(repoRoot, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    targetRef,
    sourceRef
  ]);

  if (result.error) {
    throw new Error(`Read-only merge preflight failed: ${result.error.message}`);
  }

  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const output = [stdout, stderr].filter(Boolean).join("\n");
  const treeMatch = stdout.match(/(?:^|\n)([0-9a-f]{40,64})(?:\n|$)/i);
  const conflictLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bCONFLICT\b/i.test(line));

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Read-only merge preflight could not be evaluated${output ? `: ${output}` : "."}`);
  }

  if (!treeMatch) {
    throw new Error(`Read-only merge preflight returned no candidate tree${output ? `: ${output}` : "."}`);
  }

  return {
    mergeable: result.status === 0,
    treeSha: treeMatch[1].toLowerCase(),
    conflictLines,
    output
  };
}

function sumRemovedLines(numstatOutput) {
  return String(numstatOutput || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((total, line) => {
      const [, removed = "0"] = line.split("\t");
      const parsed = Number.parseInt(removed, 10);
      return total + (Number.isNaN(parsed) ? 0 : parsed);
    }, 0);
}

function inspectDeletionImpact({ repoRoot, baseRef, candidateRef = null, cached = false }) {
  if (candidateRef && cached) {
    throw new Error("Deletion inspection cannot use candidateRef and cached together.");
  }

  const diffPrefix = ["diff"];
  if (cached) diffPrefix.push("--cached");
  const rangeArgs = candidateRef ? [baseRef, candidateRef] : [baseRef];
  const deletedOutput = requireGitSuccess(
    runGit(repoRoot, [...diffPrefix, "--name-only", "--diff-filter=D", ...rangeArgs]),
    "Inspect deleted files"
  );
  const numstatOutput = requireGitSuccess(
    runGit(repoRoot, [...diffPrefix, "--numstat", ...rangeArgs]),
    "Inspect deletion statistics"
  );

  return {
    deletedFiles: deletedOutput
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    removedLines: sumRemovedLines(numstatOutput)
  };
}

function isMergeInProgress(repoRoot) {
  const result = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  return result.status === 0;
}

function currentBranch(repoRoot) {
  const result = runGit(repoRoot, ["branch", "--show-current"]);
  if (result.status !== 0) return null;
  return String(result.stdout || "").trim() || null;
}

function recoverFailedMerge({ repoRoot, sourceBranch, targetBranch }) {
  const recovery = {
    ok: true,
    abortedMerge: false,
    returnedToSource: false,
    actions: [],
    errors: []
  };

  if (isMergeInProgress(repoRoot)) {
    const abortResult = runGit(repoRoot, ["merge", "--abort"]);
    if (abortResult.status === 0) {
      recovery.abortedMerge = true;
      recovery.actions.push("aborted the incomplete merge");
    } else {
      recovery.ok = false;
      recovery.errors.push(`could not abort merge${commandDetail(abortResult) ? `: ${commandDetail(abortResult)}` : ""}`);
    }
  }

  if (currentBranch(repoRoot) === targetBranch) {
    const switchResult = runGit(repoRoot, ["switch", sourceBranch]);
    if (switchResult.status === 0) {
      recovery.returnedToSource = true;
      recovery.actions.push(`returned to ${sourceBranch}`);
    } else {
      recovery.ok = false;
      recovery.errors.push(`could not return to ${sourceBranch}${commandDetail(switchResult) ? `: ${commandDetail(switchResult)}` : ""}`);
    }
  }

  return recovery;
}

module.exports = {
  inspectDeletionImpact,
  inspectMergePreflight,
  isMergeInProgress,
  recoverFailedMerge,
  sumRemovedLines
};
