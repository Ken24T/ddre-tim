#!/usr/bin/env node

const readline = require("readline");
const {
  fail,
  fetchOrigin,
  formatSyncStatus,
  getCurrentBranch,
  getDefaultRemote,
  getHeadCommit,
  getReachableReleaseTag,
  getShortRef,
  getWorkingTreeStatus,
  getTagsPointingAtHead,
  gitRemoteBranchExists,
  gitRemoteTagExists,
  inspectBranchSyncState,
  loadPolicy,
  logItem,
  logSection,
  printSummaryTable,
  readJsonFile,
  readVersionSource,
  resolveRepoPath,
  runCommand,
  runMutableGit,
  runShipGates,
  runtimeCwd,
  stepSemVer,
  stopIfBehindOrDiverged,
  summariseWorkingTree,
  updateJsonFileRaw
} = require("./tctbp-core");

const options = parseArgs(process.argv.slice(2));

if (options.list) {
  printUsage(0);
}

if (!options.docsNoteKind || !options.docsNote) {
  console.error("Exactly one docs-impact note is required. Use --docs-updated \"<reason>\" or --no-docs-impact \"<reason>\".");
  printUsage(1);
}

main(loadPolicy(), options).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main(config, cliOptions) {
  const branch = getCurrentBranch();
  const remote = getDefaultRemote();
  const allowedBranches = Array.isArray(config.ship && config.ship.allowedBranches) ? config.ship.allowedBranches : ["main"];

  if (branch === "HEAD") {
    fail("Ship stopped because HEAD is detached.");
  }

  if (!allowedBranches.includes(branch)) {
    fail(`Ship stopped because releases are only allowed from ${allowedBranches.join(", ")}. Current branch: '${branch}'.`);
  }

  const workingTreeSummary = summariseWorkingTree(getWorkingTreeStatus());

  if (!workingTreeSummary.isClean) {
    fail("Ship stopped because the working tree is dirty.");
  }

  fetchOrigin(cliOptions.dryRun, true);

  const remoteExists = gitRemoteBranchExists(branch);
  const syncState = inspectBranchSyncState(branch, { remoteExists, localRef: "HEAD" });
  stopIfBehindOrDiverged(syncState, `origin/${branch}`, "Ship");

  const originSha = remoteExists ? getShortRef(`refs/remotes/origin/${branch}`) : null;
  const localSha = getHeadCommit(true);
  const versionSource = readVersionSource(config);
  const versionSourceJson = readJsonFile(resolveRepoPath(versionSource.path));
  const oldVersion = String(versionSourceJson.version);
  const newVersion = stepSemVer(oldVersion, cliOptions.bump);
  const tag = formatReleaseTag(config, newVersion);
  const currentTag = getReachableReleaseTag(config);

  logSection("Ship");
  printSummaryTable([
    {
      origin: remoteExists ? `origin/${branch} @ ${originSha}` : "n/a",
      local: `${branch} @ ${localSha}`,
      status: `Branch state: ${formatSyncStatus(syncState, remoteExists)}`,
      actions: remoteExists ? "None." : "First publication is allowed during ship."
    },
    {
      origin: originSha || "n/a",
      local: localSha,
      status: "HEAD commit",
      actions: "None."
    },
    {
      origin: currentTag && gitRemoteTagExists(currentTag) ? currentTag : "n/a",
      local: currentTag || "none reachable from HEAD",
      status: "Last shipped tag",
      actions: currentTag ? "A new ship will create the next release tag." : "This looks like an untagged release candidate."
    },
    {
      origin: remoteExists ? `behind ${syncState.behind}` : "n/a",
      local: remoteExists ? `ahead ${syncState.ahead}` : "unpublished branch",
      status: "Commits ahead / behind",
      actions: syncState.ahead > 0 ? "Unpublished commits are allowed only if you intend to ship them now." : "None."
    },
    {
      origin: "n/a",
      local: workingTreeSummary.summary,
      status: "Working tree",
      actions: "None."
    },
    {
      origin: "n/a",
      local: `${versionSource.path} = ${oldVersion}`,
      status: "Version source",
      actions: `Planned bump to ${newVersion}.`
    },
    {
      origin: "n/a",
      local: `${cliOptions.docsNoteKind === "docs-updated" ? "Docs updated" : "No docs impact"}: ${cliOptions.docsNote}`,
      status: "Docs impact",
      actions: "Recorded for the ship workflow."
    },
    {
      origin: remoteExists ? originSha || "n/a" : "n/a",
      local: `${newVersion} -> ${tag}`,
      status: "Push readiness",
      actions: cliOptions.dryRun ? "Dry run only; no commit or tag will be pushed." : "Ship will commit, tag, and push the approved release."
    }
  ]);

  logItem("Remote", remote);
  logItem("Bump", `${oldVersion} -> ${newVersion} (${cliOptions.bump})`);
  logItem("Tag", tag);
  logItem("Commit", cliOptions.message || `chore(release): ${tag}`);

  if (cliOptions.dryRun) {
    console.log("Dry run: no files or git state will be modified.");
    return;
  }

  if (!cliOptions.yes) {
    const approved = await askYesNo("Proceed with ship? (y/N) ");

    if (!approved) {
      fail("Ship stopped because the release was not confirmed.");
    }
  }

  runShipGates(false);

  const versionFiles = Array.isArray(config.project && config.project.versionFiles) ? config.project.versionFiles : ["package.json"];

  for (const vf of versionFiles) {
    const vfPath = resolveRepoPath(vf);
    updateJsonFileRaw(vfPath, {
      [`"version": "${oldVersion}"`]: `"version": "${newVersion}"`
    });
  }

  if (config.profile && config.profile.versioning && config.profile.versioning.formatAfterBump) {
    runCommand("npx", ["prettier", "--write", ...versionFiles], false, "Format bumped version files");
  }

  runMutableGit(["add", ...versionFiles], false, "Stage bumped release files");
  runMutableGit(["commit", "-m", cliOptions.message || `chore(release): ${tag}`], false, "Create the release commit");
  runMutableGit(["tag", tag], false, `Create release tag ${tag}`);
  runMutableGit(["push", remote, "HEAD"], false, `Push ${branch} to ${remote}`);
  runMutableGit(["push", remote, tag], false, `Push release tag ${tag} to ${remote}`);

  const postLocalSha = getHeadCommit(true);
  const postOriginSha = getShortRef(`refs/remotes/origin/${branch}`);
  const postTagsAtHead = getTagsPointingAtHead(config);

  printSummaryTable([
    {
      origin: `${originSha || "n/a"} -> ${postOriginSha || "n/a"}`,
      local: `${localSha} -> ${postLocalSha}`,
      status: "Release commit publication",
      actions: "Commit and branch publication completed."
    },
    {
      origin: tag,
      local: postTagsAtHead.includes(tag) ? tag : "missing",
      status: "Release tag",
      actions: "Tag publication completed."
    },
    {
      origin: oldVersion,
      local: newVersion,
      status: "Version bump",
      actions: "Version files were updated and formatted."
    },
    {
      origin: postOriginSha || "n/a",
      local: postLocalSha,
      status: "Ship result",
      actions: `Release complete: ${tag}`
    }
  ]);
}

function formatReleaseTag(config, version) {
  const configuredFormat =
    config && config.profile && config.profile.versioning && typeof config.profile.versioning.tagFormat === "string"
      ? config.profile.versioning.tagFormat
      : "v{version}";

  return configuredFormat.replace("{version}", version);
}

function askYesNo(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(["y", "yes"].includes(String(answer).trim().toLowerCase()));
    });
  });
}

function parseArgs(argv) {
  const parsed = {
    bump: "patch",
    docsNoteKind: null,
    docsNote: null,
    dryRun: false,
    list: false,
    message: null,
    yes: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--bump": {
        const value = argv[index + 1];

        if (!value || !["patch", "minor", "major"].includes(value)) {
          fail("--bump requires one of: patch, minor, major.");
        }

        parsed.bump = value;
        index += 1;
        break;
      }
      case "--docs-updated":
      case "--no-docs-impact": {
        const value = argv[index + 1];

        if (!value || value.startsWith("--")) {
          fail(`${arg} requires a quoted reason.`);
        }

        if (parsed.docsNoteKind) {
          fail("Provide only one docs-impact flag.");
        }

        parsed.docsNoteKind = arg === "--docs-updated" ? "docs-updated" : "no-docs-impact";
        parsed.docsNote = value;
        index += 1;
        break;
      }
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--list":
        parsed.list = true;
        break;
      case "--message": {
        const value = argv[index + 1];

        if (!value || value.startsWith("--")) {
          fail("--message requires a quoted commit message.");
        }

        parsed.message = value;
        index += 1;
        break;
      }
      case "--yes":
        parsed.yes = true;
        break;
      default:
        fail(`Unknown option '${arg}'.`);
    }
  }

  return parsed;
}

function printUsage(exitCode) {
  console.log(
    "Usage: node scripts/tctbp-run-ship.js [--bump patch|minor|major] [--docs-updated \"<reason>\" | --no-docs-impact \"<reason>\"] [--message \"<message>\"] [--dry-run] [--yes] [--list]"
  );
  process.exit(exitCode);
}