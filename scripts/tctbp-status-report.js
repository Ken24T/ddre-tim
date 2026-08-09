#!/usr/bin/env node

const { spawnSync } = require("child_process");

function captureBranchSnapshots(repoRoot, branchNames) {
  const snapshots = {};

  for (const branchName of uniqueBranchNames(branchNames)) {
    snapshots[branchName] = {
      localSha: resolveShortRef(repoRoot, `refs/heads/${branchName}`),
      originSha: resolveShortRef(repoRoot, `refs/remotes/origin/${branchName}`)
    };
  }

  return snapshots;
}

function printPostTriggerStatusReport({
  repoRoot,
  title,
  outcome,
  currentBranch,
  branchNames,
  beforeSnapshot = null,
  branchActions = {},
  extraItems = [],
  nextSteps = []
}) {
  const afterSnapshot = captureBranchSnapshots(repoRoot, branchNames);
  const workingTreeSummary = getWorkingTreeSummary(repoRoot);
  const currentHeadSummary = runGitCapture(repoRoot, ["log", "-1", "--oneline", "--decorate=short", "--no-color", "HEAD"], true);
  const changedRefs = beforeSnapshot ? describeChangedRefs(beforeSnapshot, afterSnapshot) : [];

  console.log("");
  console.log(title);
  console.log("=".repeat(title.length));
  console.log(`Outcome: ${outcome}`);
  console.log(`Checked out: ${currentBranch}`);
  console.log(`HEAD: ${currentHeadSummary || "unknown"}`);
  console.log(`Working tree: ${workingTreeSummary}`);

  for (const item of extraItems) {
    if (!item || !item.label || !item.value) {
      continue;
    }

    console.log(`${item.label}: ${item.value}`);
  }

  console.log("Changed refs:");

  if (changedRefs.length === 0) {
    console.log("- none");
  } else {
    for (const line of changedRefs) {
      console.log(`- ${line}`);
    }
  }

  console.log("");
  console.log("| Branch | Origin | Local | Status | Action(s) |");
  console.log("| --- | --- | --- | --- | --- |");

  for (const branchName of uniqueBranchNames(branchNames)) {
    const row = buildBranchStatusRow({
      repoRoot,
      branchName,
      currentBranch,
      snapshot: afterSnapshot[branchName],
      actionOverride: branchActions[branchName]
    });

    console.log(
      `| ${escapeTableCell(row.branch)} | ${row.originSha} | ${row.localSha} | ${escapeTableCell(row.status)} | ${escapeTableCell(row.action)} |`
    );
  }

  if (nextSteps.length > 0) {
    console.log("");
    console.log("Next steps:");

    for (const step of nextSteps) {
      console.log(`- ${step}`);
    }
  }
}

function buildBranchStatusRow({ repoRoot, branchName, currentBranch, snapshot, actionOverride }) {
  const localSha = snapshot && snapshot.localSha ? snapshot.localSha : "missing";
  const originSha = snapshot && snapshot.originSha ? snapshot.originSha : "missing";
  const localExists = Boolean(snapshot && snapshot.localSha);
  const remoteExists = Boolean(snapshot && snapshot.originSha);
  const syncState = localExists && remoteExists ? inspectBranchSyncState(repoRoot, branchName) : null;
  const statusInfo = describeBranchStatus(localExists, remoteExists, syncState);

  return {
    branch: branchName === currentBranch ? `${branchName} (current)` : branchName,
    originSha,
    localSha,
    status: statusInfo.status,
    action: typeof actionOverride === "string" && actionOverride.trim().length > 0 ? actionOverride : getDefaultAction(statusInfo.key)
  };
}

function describeBranchStatus(localExists, remoteExists, syncState) {
  if (!localExists && !remoteExists) {
    return {
      key: "missing-both",
      status: "Missing locally and on origin"
    };
  }

  if (!localExists) {
    return {
      key: "missing-local",
      status: "Missing locally"
    };
  }

  if (!remoteExists) {
    return {
      key: "missing-remote",
      status: "Local only; not published"
    };
  }

  if (syncState.diverged) {
    return {
      key: "diverged",
      status: `Diverged (ahead ${syncState.ahead}, behind ${syncState.behind})`
    };
  }

  if (syncState.ahead > 0) {
    return {
      key: "ahead",
      status: `Ahead of origin by ${syncState.ahead}`
    };
  }

  if (syncState.behind > 0) {
    return {
      key: "behind",
      status: `Behind origin by ${syncState.behind}`
    };
  }

  return {
    key: "in-sync",
    status: "In sync"
  };
}

function getDefaultAction(statusKey) {
  switch (statusKey) {
    case "missing-both":
      return "Create the branch before using it.";
    case "missing-local":
      return "Create or switch the local branch before continuing.";
    case "missing-remote":
      return "Publish the branch when the workflow allows it.";
    case "ahead":
      return "Confirm whether this branch should be published by the active workflow.";
    case "behind":
      return "Pull or rerun recovery before using this branch.";
    case "diverged":
      return "Stop and reconcile with origin before continuing.";
    default:
      return "None.";
  }
}

function describeChangedRefs(beforeSnapshot, afterSnapshot) {
  const branchNames = uniqueBranchNames([...Object.keys(beforeSnapshot || {}), ...Object.keys(afterSnapshot || {})]);
  const changes = [];

  for (const branchName of branchNames) {
    const beforeBranch = beforeSnapshot && beforeSnapshot[branchName] ? beforeSnapshot[branchName] : {};
    const afterBranch = afterSnapshot && afterSnapshot[branchName] ? afterSnapshot[branchName] : {};

    if (formatSha(beforeBranch.localSha) !== formatSha(afterBranch.localSha)) {
      changes.push(`${branchName} local: ${formatSha(beforeBranch.localSha)} -> ${formatSha(afterBranch.localSha)}`);
    }

    if (formatSha(beforeBranch.originSha) !== formatSha(afterBranch.originSha)) {
      changes.push(`origin/${branchName}: ${formatSha(beforeBranch.originSha)} -> ${formatSha(afterBranch.originSha)}`);
    }
  }

  return changes;
}

function getWorkingTreeSummary(repoRoot) {
  const statusOutput = runGitCapture(repoRoot, ["status", "--porcelain", "--untracked-files=all"], true);

  if (!statusOutput) {
    return "clean";
  }

  const count = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0).length;

  return `dirty (${count} path${count === 1 ? "" : "s"})`;
}

function inspectBranchSyncState(repoRoot, branchName) {
  const output = runGitCapture(repoRoot, ["rev-list", "--left-right", "--count", `refs/heads/${branchName}...refs/remotes/origin/${branchName}`]);
  const parts = output.split(/\s+/).map((value) => Number.parseInt(value, 10));

  if (parts.length !== 2 || parts.some((value) => Number.isNaN(value))) {
    throw new Error(`Could not parse branch sync state output for ${branchName}: '${output}'.`);
  }

  return {
    ahead: parts[0],
    behind: parts[1],
    diverged: parts[0] > 0 && parts[1] > 0
  };
}

function resolveShortRef(repoRoot, refName) {
  if (!gitRefExists(repoRoot, refName)) {
    return null;
  }

  return runGitCapture(repoRoot, ["rev-parse", "--short", refName]);
}

function gitRefExists(repoRoot, refName) {
  const result = spawnSync("git", ["rev-parse", "--verify", refName], {
    cwd: repoRoot,
    stdio: "ignore"
  });

  return result.status === 0;
}

function runGitCapture(repoRoot, args, allowEmpty = false) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `git ${args.join(" ")} failed with exit code ${result.status}`);
  }

  const stdout = (result.stdout || "").trim();

  if (!allowEmpty && !stdout) {
    throw new Error(`git ${args.join(" ")} returned no output`);
  }

  return stdout;
}

function uniqueBranchNames(branchNames) {
  return [...new Set((branchNames || []).filter((value) => typeof value === "string" && value.trim().length > 0))];
}

function formatSha(value) {
  return value || "missing";
}

function escapeTableCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

module.exports = {
  captureBranchSnapshots,
  printPostTriggerStatusReport
};