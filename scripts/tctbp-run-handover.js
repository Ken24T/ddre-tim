#!/usr/bin/env node

const {
  createTimestamp,
  detectGitOperationState,
  fail,
  fetchOrigin,
  formatSyncStatus,
  getCurrentBranch,
  getHeadCommit,
  getShortRef,
  getWorkingTreeStatus,
  gitRemoteBranchExists,
  inspectBranchSyncState,
  loadPolicy,
  logItem,
  logSection,
  printSummaryTable,
  repoRoot,
  runCommand,
  runMutableGit,
  runShellCommand,
  summariseWorkingTree
} = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printUsage(0);
}

main(loadPolicy(), options).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main(config, cliOptions) {
  const branch = getCurrentBranch();

  if (branch === "HEAD") {
    fail("Handover stopped because HEAD is detached.");
  }

  const operationStates = detectGitOperationState();
  if (operationStates.length > 0) {
    fail(`Handover stopped because ${operationStates.join(", ")} is already in progress.`);
  }

  logSection("Handover");
  logItem("Repo", repoRoot.split("/").pop() || repoRoot);
  logItem("Branch", branch);
  logItem("Mode", cliOptions.localOnly ? "local-only" : cliOptions.dryRun ? "dry-run" : "live");

  if (!cliOptions.localOnly) {
    runRuntimeAdvisory(config, cliOptions.dryRun);
    fetchOrigin(cliOptions.dryRun, true);

    const remoteExistsBefore = gitRemoteBranchExists(branch);
    const syncStateBefore = inspectBranchSyncState(branch, {
      remoteExists: remoteExistsBefore,
      localRef: "HEAD"
    });

    if (syncStateBefore.diverged) {
      fail(`Handover stopped because ${branch} has diverged from origin/${branch}.`);
    }

    if (syncStateBefore.behind > 0) {
      fail(`Handover stopped because ${branch} is behind origin/${branch} by ${syncStateBefore.behind} commit(s).`);
    }
  }

  let originBefore = null;
  let remoteExistsBefore = false;
  let remoteExistsAfter = false;
  let syncStateAfter = null;
  let originAfter = null;

  if (!cliOptions.localOnly) {
    remoteExistsBefore = gitRemoteBranchExists(branch);
    originBefore = remoteExistsBefore ? getShortRef(`refs/remotes/origin/${branch}`) : null;
  }

  const preHead = getHeadCommit(true);
  const preWorkingTree = summariseWorkingTree(getWorkingTreeStatus());

  let checkpointCreated = false;
  if (!preWorkingTree.isClean) {
    runCommand(
      "node",
      ["scripts/tctbp-run-checkpoint.js", ...(cliOptions.dryRun ? ["--dry-run"] : [])],
      cliOptions.dryRun,
      "Run checkpoint step during handover"
    );
    checkpointCreated = true;
  } else {
    console.log("Working tree is already clean; checkpoint step skipped.");
  }

  const postCheckpointHead = getHeadCommit(true);

  if (!cliOptions.localOnly) {
    runCommand(
      "node",
      ["scripts/tctbp-run-publish.js", ...(cliOptions.dryRun ? ["--dry-run"] : [])],
      cliOptions.dryRun,
      "Run publish step during handover"
    );

    remoteExistsAfter = cliOptions.dryRun ? remoteExistsBefore : gitRemoteBranchExists(branch);
    syncStateAfter = cliOptions.dryRun
      ? inspectBranchSyncState(branch, { remoteExists: remoteExistsBefore, localRef: "HEAD" })
      : inspectBranchSyncState(branch, { remoteExists: remoteExistsAfter, localRef: "HEAD" });
    originAfter = remoteExistsAfter ? getShortRef(`refs/remotes/origin/${branch}`) : null;

    if (!cliOptions.dryRun && (!remoteExistsAfter || syncStateAfter.ahead > 0 || syncStateAfter.behind > 0 || syncStateAfter.diverged)) {
      fail("Handover stopped because branch sync could not be verified after publication.");
    }
  } else {
    console.log("Local-only mode: skipping publish step.");
  }

  const finalHead = getHeadCommit(true);
  const finalWorkingTree = summariseWorkingTree(getWorkingTreeStatus());

  // ── Continuation note ─────────────────────────────────────────────────

  const continuationWritten = await writeContinuationNote(config, cliOptions, branch, finalHead);

  printSummaryTable([
    {
      origin: originBefore || "n/a",
      local: `${branch} @ ${preHead}`,
      status: "Start state",
      actions: preWorkingTree.isClean ? "Working tree was clean." : "Working tree had local changes."
    },
    {
      origin: "n/a",
      local: checkpointCreated ? `${preHead} -> ${postCheckpointHead}` : "no checkpoint needed",
      status: "Checkpoint step",
      actions: checkpointCreated ? "Local checkpoint created." : "Skipped because working tree was already clean."
    },
    ...(cliOptions.localOnly ? [{
      origin: "n/a",
      local: `${branch} @ ${finalHead}`,
      status: "Publish step",
      actions: "Skipped — local-only mode. No remote interaction."
    }] : [{
      origin: `${originBefore || "n/a"} -> ${originAfter || "n/a"}`,
      local: `${branch} @ ${finalHead}`,
      status: `Upstream sync: ${syncStateAfter ? formatSyncStatus(syncStateAfter, remoteExistsAfter) : "n/a"}`,
      actions: cliOptions.dryRun ? "Dry run only; no remote update occurred." : "Branch publication and sync verification completed."
    }]),
    {
      origin: "n/a",
      local: finalWorkingTree.summary,
      status: "Final baseline",
      actions: finalWorkingTree.isClean
        ? (continuationWritten ? "Ready to resume. Continuation note saved." : "Ready to resume.")
        : "Resolve local changes before relying on handover baseline."
    }
  ]);

  console.log(`Handover ${cliOptions.dryRun ? "plan" : "workflow"} complete for ${branch} at ${finalHead}.`);
  if (continuationWritten) {
    console.log(`Continuation note saved. Use "resume" or "orient" when you return to this repo.`);
  }
}

async function writeContinuationNote(_config, cliOptions, branch, commit) {
  if (cliOptions.dryRun) {
    console.log("[dry-run] Would write a fully automated continuation file from git context.");
    return false;
  }

  if (cliOptions.noContinuation) {
    return false;
  }

  const fs = require("fs");
  const path = require("path");
  const { spawnSync } = require("child_process");

  // ── Gather git context ────────────────────────────────────────────────

  const sessionStartRef = resolveSessionStartRef();

  const gitLog = runGitCaptureSilent(
    ["log", "--oneline", "--decorate", `${sessionStartRef}..HEAD`],
    repoRoot
  );
  const commitList = gitLog
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const fileDiff = runGitCaptureSilent(
    ["diff", "--stat", `${sessionStartRef}..HEAD`],
    repoRoot
  );

  const untrackedFiles = runGitCaptureSilent(
    ["ls-files", "--others", "--exclude-standard"],
    repoRoot
  );

  const workingTree = runGitCaptureSilent(
    ["status", "--porcelain"],
    repoRoot
  );

  // ── Analyze changes ──────────────────────────────────────────────────

  // Count new vs modified files
  const newFiles = [];
  const modifiedFiles = [];
  const diffLines = fileDiff.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  for (const line of diffLines) {
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const filePath = parts[0].trim();
    const stat = parts[1].trim();
    // git diff --stat: new files show only additions, modified show both
    if (stat.includes("+") && !stat.includes("-")) {
      newFiles.push({ path: filePath, stat });
    } else {
      modifiedFiles.push({ path: filePath, stat });
    }
  }

  // Net line delta
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const line of diffLines) {
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const stat = parts[1].trim();
    const addMatch = stat.match(/(\d+)\s*\+/);
    const delMatch = stat.match(/(\d+)\s*\-/);
    if (addMatch) totalAdded += parseInt(addMatch[1], 10);
    if (delMatch) totalRemoved += parseInt(delMatch[1], 10);
  }

  // Extract meaningful commit messages (non-checkpoint, non-handover)
  const meaningfulCommits = commitList.filter((c) => {
    const msg = c.slice(c.indexOf(" ") + 1).toLowerCase();
    return !msg.startsWith("checkpoint:") && !msg.startsWith("handover:");
  });

  // Categorize files by directory
  const byDir = {};
  for (const f of [...newFiles, ...modifiedFiles]) {
    const dir = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
    if (!byDir[dir]) byDir[dir] = [];
    byDir[dir].push(f.path);
  }

  // ── Assemble document ─────────────────────────────────────────────────

  const timestamp = createTimestamp();
  const dateStr = new Date().toISOString().replace("T", " ").slice(0, 19);
  const continuationDir = path.join(repoRoot, ".tctbp", "continuation");
  fs.mkdirSync(continuationDir, { recursive: true });

  const fileName = `${timestamp}-handover.md`;
  const filePath = path.join(continuationDir, fileName);

  // Files touched table
  let filesTable = "_No files changed this session._";
  if (diffLines.length > 0) {
    filesTable = "| File | Change |\n|------|--------|\n";
    for (const line of diffLines) {
      const parts = line.split("|");
      if (parts.length >= 2) {
        filesTable += `| \`${parts[0].trim()}\` | ${parts[1].trim()} |\n`;
      }
    }
  }

  // Checkpoint log (compact)
  let checkpoints = "_No commits this session._";
  if (commitList.length > 0) {
    checkpoints = "| Commit | Message |\n|--------|--------|\n";
    for (const c of commitList) {
      const firstSpace = c.indexOf(" ");
      const sha = firstSpace > 0 ? c.slice(0, firstSpace) : c;
      const msg = firstSpace > 0 ? c.slice(firstSpace + 1) : "";
      checkpoints += `| \`${sha}\` | ${msg} |\n`;
    }
  }

  // Directory breakdown
  let dirSummary = "";
  if (Object.keys(byDir).length > 0) {
    dirSummary = "| Directory | Files |\n|-----------|------|\n";
    for (const [dir, files] of Object.entries(byDir).sort()) {
      dirSummary += `| \`${dir}/\` | ${files.length} |\n`;
    }
  }

  // Build summary section — use copilot note if provided, else auto-generated
  const netDelta = totalAdded - totalRemoved;
  const deltaLabel = netDelta >= 0 ? `+${netDelta}` : `${netDelta}`;
  const netDeltaLine = netDelta !== 0
    ? `Net change: ${deltaLabel} lines (+${totalAdded} added, −${totalRemoved} removed).`
    : "No net line change.";
  const meaningfulLine = meaningfulCommits.length > 0
    ? `${meaningfulCommits.length} meaningful commit(s) — checkpoint commits excluded.`
    : "";

  // Resolve note: --note takes priority, then --note-file, then auto-generate
  let copilotNote = cliOptions.note || "";
  if (!copilotNote.trim() && cliOptions.noteFile) {
    try {
      copilotNote = fs.readFileSync(cliOptions.noteFile, "utf8").trim();
      if (copilotNote) {
        console.log(`Session note loaded from ${cliOptions.noteFile}`);
      }
    } catch (e) {
      console.log(`⚠️  Could not read --note-file ${cliOptions.noteFile}: ${e.message}`);
    }
  }

  const summarySection = copilotNote.trim()
    ? copilotNote.trim()
    : buildAutoSummary(
        commitList,
        meaningfulCommits,
        diffLines,
        newFiles,
        modifiedFiles,
        totalAdded,
        totalRemoved,
        netDelta,
        deltaLabel,
        netDeltaLine,
        meaningfulLine,
        byDir,
        dirSummary,
        sessionStartRef
      );

  const treeStatus = workingTree.trim()
    ? `\`\`\`\n${workingTree}\n\`\`\``
    : "clean";

  const content = [
    `# Handover Continuation — ${dateStr.slice(0, 10)}`,
    "",
    `*Auto-generated by TCTBP handover on ${dateStr}*`,
    "",
    "## Session Summary",
    "",
    summarySection,
    "## Files Touched",
    "",
    filesTable,
    "",
    "## Checkpoint Log",
    "",
    checkpoints,
    "",
    "## Branch & Commit Context",
    "",
    `- **Branch:** ${branch}`,
    `- **Last commit:** ${commit}`,
    `- **Working tree:** ${treeStatus}`,
    `- **Session range:** ${sessionStartRef}..HEAD`,
    "",
    "---",
    "",
    `*Generated by TCTBP handover on ${dateStr}*`,
    ""
  ].join("\n");

  fs.writeFileSync(filePath, content, "utf8");

  console.log(`\nContinuation file: .tctbp/continuation/${fileName}`);
  console.log(`Auto-generated from git: ${commitList.length} commits, ${diffLines.length} files`);

  // Prune old continuation files, keeping the most recent N
  const maxFiles = (_config && _config.handover && typeof _config.handover.maxContinuationFiles === "number")
    ? _config.handover.maxContinuationFiles
    : 5;
  pruneContinuationFiles(continuationDir, maxFiles);

  // Stage, commit, and push (skip push for local-only)
  spawnSync("git", ["add", ".tctbp/continuation/"], { cwd: repoRoot, stdio: "inherit" });
  const commitResult = spawnSync("git", ["commit", "-m", "handover: continuation note"], { cwd: repoRoot, stdio: "inherit" });

  if (commitResult.status === 0) {
    if (cliOptions.localOnly) {
      console.log("Committed (local-only — not pushed).");
    } else {
      spawnSync("git", ["push", "origin", branch], { cwd: repoRoot, stdio: "inherit" });
      console.log("Committed and pushed.");
    }
  }

  return true;
}

/**
 * Prune old continuation files, keeping only the most recent `maxFiles`.
 * Files are sorted by name (timestamped), so oldest sort first.
 */
function pruneContinuationFiles(continuationDir, maxFiles) {
  const fs = require("fs");
  const path = require("path");

  let files = [];
  try {
    files = fs.readdirSync(continuationDir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (_) {
    return; // directory doesn't exist yet
  }

  if (files.length <= maxFiles) return;

  const toDelete = files.slice(0, files.length - maxFiles);

  for (const name of toDelete) {
    const filePath = path.join(continuationDir, name);
    try {
      fs.unlinkSync(filePath);
      console.log(`Pruned old continuation: .tctbp/continuation/${name}`);
    } catch (e) {
      console.log(`⚠️  Could not prune ${name}: ${e.message}`);
    }
  }

  if (toDelete.length > 0) {
    console.log(`Pruned ${toDelete.length} old continuation file(s) — kept ${maxFiles} most recent.`);
  }
}

/**
 * Build an auto-generated summary from git context when no --note is provided.
 * Uses meaningful commit messages as the primary narrative content.
 */
function buildAutoSummary(
  commitList,
  meaningfulCommits,
  diffLines,
  newFiles,
  modifiedFiles,
  totalAdded,
  totalRemoved,
  netDelta,
  deltaLabel,
  netDeltaLine,
  meaningfulLine,
  byDir,
  dirSummary,
  sessionStartRef
) {
  const parts = [];

  // Header noting this is auto-generated
  parts.push("*Auto-generated from git context — no Copilot narrative was provided.*");
  parts.push("");

  // Use meaningful commit messages as the work summary
  if (meaningfulCommits.length > 0) {
    parts.push("**Work done this session:**");
    parts.push("");
    for (const c of meaningfulCommits) {
      const firstSpace = c.indexOf(" ");
      const msg = firstSpace > 0 ? c.slice(firstSpace + 1).trim() : c.trim();
      parts.push(`- ${msg}`);
    }
    parts.push("");
  } else if (commitList.length > 0) {
    parts.push("**Work done this session:**");
    parts.push("");
    for (const c of commitList) {
      const firstSpace = c.indexOf(" ");
      const msg = firstSpace > 0 ? c.slice(firstSpace + 1).trim() : c.trim();
      parts.push(`- ${msg}`);
    }
    parts.push("");
  } else {
    parts.push("_No commits in this session range._");
    parts.push("");
  }

  // Stats footer
  const stats = [];
  if (commitList.length > 0) {
    stats.push(`${commitList.length} commit(s) across ${diffLines.length} file(s) since ${sessionStartRef}.`);
  }
  if (newFiles.length > 0 || modifiedFiles.length > 0) {
    stats.push(`${newFiles.length} new, ${modifiedFiles.length} modified.`);
  }
  if (netDelta !== 0) {
    stats.push(`${netDeltaLine}`);
  }
  if (stats.length > 0) {
    parts.push(stats.join(" "));
  }

  // Directory breakdown
  if (Object.keys(byDir).length > 0) {
    parts.push("");
    parts.push("### By Directory");
    parts.push("");
    parts.push(dirSummary);
  }

  return parts.join("\n");
}

function resolveSessionStartRef() {
  // Try the last shipped tag first, then HEAD~20, then the root commit.
  const { spawnSync } = require("child_process");
  const tagResult = spawnSync("git", ["describe", "--tags", "--abbrev=0"], {
    cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  const tag = (tagResult.stdout || "").trim();
  if (tag) return tag;

  // No tags — try 20 commits back
  const checkResult = spawnSync("git", ["rev-parse", "--verify", "HEAD~20"], {
    cwd: repoRoot, stdio: "ignore"
  });
  if (checkResult.status === 0) return "HEAD~20";

  // Very young repo — use the root commit
  return "HEAD~1";
}

function runGitCaptureSilent(args, cwd) {
  const { spawnSync } = require("child_process");
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function runRuntimeAdvisory(config, dryRun) {
  const advisory = config && config.handover && config.handover.runtimeAdvisory;
  const command = advisory && typeof advisory.executionCommand === "string" ? advisory.executionCommand.trim() : "";

  if (!command) {
    return;
  }

  runShellCommand(command, dryRun, "Run handover runtime advisory");
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    list: false,
    localOnly: false,
    noContinuation: false,
    note: null,
    noteFile: null
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    if (arg === "--local-only") {
      parsed.localOnly = true;
      continue;
    }

    if (arg === "--no-continuation") {
      parsed.noContinuation = true;
      continue;
    }

    if (arg === "--note") {
      // --note consumes all remaining args as the note text
      const remaining = argv.slice(argv.indexOf(arg) + 1);
      parsed.note = remaining.join(" ");
      break;
    }

    if (arg === "--note-file") {
      const idx = argv.indexOf(arg);
      if (idx + 1 >= argv.length) {
        fail("--note-file requires a path argument.");
      }
      parsed.noteFile = argv[idx + 1];
      // skip the next arg (the path)
      argv.splice(idx, 1);
      continue;
    }

    fail(`Unknown option '${arg}'.`);
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log("Usage: node scripts/tctbp-run-handover.js [--dry-run] [--local-only] [--no-continuation] [--note \"<markdown>\"] [--note-file <path>] [--list]");
  process.exit(exitCode);
}
