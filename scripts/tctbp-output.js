#!/usr/bin/env node

const { classifyStatusLine } = require("./tctbp-git-ops");

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ── Logging helpers ─────────────────────────────────────────────────────────

function logSection(title) {
  console.log(title);
  console.log("=".repeat(title.length));
}

function logItem(label, value) {
  console.log(`${label}: ${value}`);
}

// ── String escaping ─────────────────────────────────────────────────────────

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTableCell(value) {
  return String(value ?? "n/a").replace(/\|/g, "\\|");
}

// ── Timestamps ──────────────────────────────────────────────────────────────

function createTimestamp() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

// ── Working tree formatting ─────────────────────────────────────────────────

function summariseWorkingTree(statusOutput) {
  const lines = statusOutput
    .split(/\r?\n/)
    .map((value) => value.trimEnd())
    .filter((value) => value.length > 0);

  const counts = {
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    untracked: 0,
    other: 0
  };

  for (const line of lines) {
    counts[classifyStatusLine(line)] += 1;
  }

  const summaryParts = [
    ["modified", counts.modified],
    ["added", counts.added],
    ["deleted", counts.deleted],
    ["renamed", counts.renamed],
    ["copied", counts.copied],
    ["untracked", counts.untracked],
    ["other", counts.other]
  ]
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`);

  return {
    counts,
    isClean: lines.length === 0,
    lines,
    summary: lines.length === 0 ? "clean" : `dirty (${lines.length} path${lines.length === 1 ? "" : "s"}: ${summaryParts.join(", ")})`
  };
}

function printDirtySummary(statusOutput, label, stagedLine) {
  const summary = summariseWorkingTree(statusOutput);

  if (summary.lines.length === 0) {
    return;
  }

  console.log(`${label} (${summary.lines.length} file(s)): ${summary.summary.replace(/^dirty \(\d+ paths?: /, "").replace(/\)$/, "")}`);
  console.log(stagedLine);

  for (const line of summary.lines) {
    console.log(`- ${line}`);
  }
}

function formatSyncStatus(syncState, remoteExists) {
  if (!remoteExists) {
    return "Unpublished";
  }

  if (syncState.diverged) {
    return `Diverged (ahead ${syncState.ahead}, behind ${syncState.behind})`;
  }

  if (syncState.ahead > 0) {
    return `Ahead of origin by ${syncState.ahead}`;
  }

  if (syncState.behind > 0) {
    return `Behind origin by ${syncState.behind}`;
  }

  return "In sync";
}

// ── Summary table rendering ─────────────────────────────────────────────────

function printSummaryTable(rows) {
  console.log("");
  console.log("| Origin | Local | Status | Action(s) |");
  console.log("| --- | --- | --- | --- |");

  for (const row of rows) {
    console.log(
      `| ${escapeTableCell(row.origin)} | ${escapeTableCell(row.local)} | ${escapeTableCell(row.status)} | ${escapeTableCell(row.actions)} |`
    );
  }

  console.log("");
}

// ── Status recommendations ──────────────────────────────────────────────────

function resolveStatusRecommendations(input) {
  if (input.operationStates.length > 0) {
    return ["abort"];
  }

  if (input.currentBranch === "HEAD" || input.currentSyncState.diverged) {
    return ["investigate"];
  }

  if (!input.workingTreeSummary.isClean && input.currentSyncState.behind > 0) {
    return ["investigate"];
  }

  const unpublishedOrAhead =
    input.currentRemoteExists === false || input.currentSyncState.ahead > 0;

  if (
    input.enableHandoverSuggestions === true &&
    (!input.workingTreeSummary.isClean || unpublishedOrAhead)
  ) {
    return ["handover"];
  }

  if (!input.workingTreeSummary.isClean) {
    return ["checkpoint"];
  }

  if (input.currentSyncState.behind > 0) {
    return ["resume"];
  }

  if (unpublishedOrAhead) {
    return ["publish"];
  }

  if (input.currentBranch === input.defaultBranch && input.shipReadiness.ready) {
    return ["ship"];
  }

  return ["none"];
}

module.exports = {
  createTimestamp,
  escapeRegExp,
  escapeTableCell,
  fail,
  formatSyncStatus,
  logItem,
  logSection,
  printDirtySummary,
  printSummaryTable,
  resolveStatusRecommendations,
  summariseWorkingTree
};
