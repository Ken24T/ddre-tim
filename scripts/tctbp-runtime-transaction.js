"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

class RuntimePublishError extends Error {
  constructor(message, { cause = null, rollback = null } = {}) {
    super(message);
    this.name = "RuntimePublishError";
    this.cause = cause;
    this.rollback = rollback;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function snapshotTree(rootPath) {
  if (!fs.existsSync(rootPath)) throw new Error(`Snapshot root does not exist: ${rootPath}`);
  const snapshot = {};

  function visit(entryPath, relativePath) {
    const stat = fs.lstatSync(entryPath);
    const key = relativePath || ".";
    if (stat.isSymbolicLink()) {
      snapshot[key] = { type: "symlink", target: fs.readlinkSync(entryPath) };
      return;
    }
    if (stat.isDirectory()) {
      snapshot[key] = { type: "directory" };
      for (const child of fs.readdirSync(entryPath).sort()) {
        visit(path.join(entryPath, child), relativePath ? path.posix.join(relativePath, child) : child);
      }
      return;
    }
    if (stat.isFile()) {
      snapshot[key] = { type: "file", size: stat.size, sha256: sha256File(entryPath) };
      return;
    }
    throw new Error(`Unsupported runtime bundle entry: ${entryPath}`);
  }

  visit(rootPath, "");
  return snapshot;
}

function verifyCopiedTree(sourcePath, stagedPath) {
  const source = snapshotTree(sourcePath);
  const staged = snapshotTree(stagedPath);
  if (JSON.stringify(source) !== JSON.stringify(staged)) {
    throw new Error("Staged runtime bundle does not exactly match the build output.");
  }
  return staged;
}

function atomicWriteBuffer(filePath, content, mode = 0o600) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, content, { flag: "wx", mode });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, mode);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteBuffer(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function ensureVacantPath(targetPath, label) {
  if (fs.existsSync(targetPath)) throw new Error(`${label} already exists: ${targetPath}`);
}

function stageRuntimeBundle(sourceDist, stagingPath) {
  ensureVacantPath(stagingPath, "Runtime staging path");
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true, mode: 0o700 });
  fs.cpSync(sourceDist, stagingPath, { recursive: true, errorOnExist: true, force: false });
  verifyCopiedTree(sourceDist, stagingPath);
}

function restoreRuntimeState(runtimeStatePath, previousContent) {
  if (!runtimeStatePath) return;
  if (previousContent === null) {
    if (fs.existsSync(runtimeStatePath)) fs.unlinkSync(runtimeStatePath);
    return;
  }
  atomicWriteBuffer(runtimeStatePath, previousContent);
}

function validateEntrypoint(sourceDist, entrypoint, validateEntry) {
  if (typeof validateEntry === "function") {
    validateEntry(sourceDist, entrypoint);
    return;
  }
  if (entrypoint && !fs.existsSync(path.join(sourceDist, entrypoint))) {
    throw new Error(`Missing configured runtime entrypoint at ${path.join(sourceDist, entrypoint)}`);
  }
}

function publishRuntimeTransaction({
  sourceDist,
  destinationDist,
  backupPath,
  stagingPath,
  failedPath,
  runtimeStatePath = null,
  nextRuntimeState = null,
  stopRuntime,
  startAndVerifyRuntime,
  stopService,
  startAndVerifyService,
  writeNextRuntimeState = atomicWriteJson,
  entrypoint = null,
  validateEntry,
  dryRun = false
}) {
  const stop = stopRuntime || stopService;
  const startAndVerify = startAndVerifyRuntime || startAndVerifyService;
  if (typeof stop !== "function") throw new Error("stopRuntime must be a function.");
  if (typeof startAndVerify !== "function") throw new Error("startAndVerifyRuntime must be a function.");
  if (!sourceDist || !destinationDist || !backupPath || !stagingPath || !failedPath) {
    throw new Error("Runtime transaction paths are required.");
  }
  if (!fs.existsSync(sourceDist)) throw new Error(`Runtime build output does not exist: ${sourceDist}`);
  validateEntrypoint(sourceDist, entrypoint, validateEntry);

  if (dryRun) {
    return { dryRun: true, sourceDist, stagingPath, destinationDist, backupPath: fs.existsSync(destinationDist) ? backupPath : null, failedPath };
  }

  ensureVacantPath(backupPath, "Runtime backup path");
  ensureVacantPath(failedPath, "Failed-candidate path");
  const previousRuntimeState = runtimeStatePath && fs.existsSync(runtimeStatePath) ? fs.readFileSync(runtimeStatePath) : null;
  const hadPreviousBundle = fs.existsSync(destinationDist);
  let backupCreated = false;
  let candidateActivated = false;
  let liveTransactionStarted = false;
  let primaryError = null;

  try {
    stageRuntimeBundle(sourceDist, stagingPath);
    liveTransactionStarted = true;
    stop();
    if (hadPreviousBundle) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      fs.renameSync(destinationDist, backupPath);
      backupCreated = true;
    }
    fs.renameSync(stagingPath, destinationDist);
    candidateActivated = true;
    startAndVerify();
    if (runtimeStatePath && nextRuntimeState !== null) writeNextRuntimeState(runtimeStatePath, nextRuntimeState);
    return { dryRun: false, backupPath: backupCreated ? backupPath : null, destinationDist, failedPath: null, rolledBack: false };
  } catch (error) {
    primaryError = error;
  } finally {
    if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true });
  }

  if (!liveTransactionStarted) {
    throw new RuntimePublishError(`Runtime publication failed before activation: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}. The live runtime was not changed.`, {
      cause: primaryError,
      rollback: { notRequired: true, previousBundleRestored: true, runtimeStateRestored: true, runtimeRestored: true, failedCandidatePath: null, errors: [] }
    });
  }

  const rollbackErrors = [];
  let previousBundleRestored = false;
  let runtimeStateRestored = false;
  let runtimeRestored = false;
  let failedCandidatePath = null;
  try {
    stop();
  } catch (error) {
    rollbackErrors.push(`could not stop runtime for rollback: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (candidateActivated && fs.existsSync(destinationDist)) {
      fs.mkdirSync(path.dirname(failedPath), { recursive: true, mode: 0o700 });
      fs.renameSync(destinationDist, failedPath);
      failedCandidatePath = failedPath;
    }
    if (backupCreated && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, destinationDist);
      previousBundleRestored = true;
    } else if (!hadPreviousBundle) {
      previousBundleRestored = !fs.existsSync(destinationDist);
    } else {
      previousBundleRestored = fs.existsSync(destinationDist);
    }
  } catch (error) {
    rollbackErrors.push(`could not restore previous runtime bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    restoreRuntimeState(runtimeStatePath, previousRuntimeState);
    runtimeStateRestored = true;
  } catch (error) {
    rollbackErrors.push(`could not restore runtime-state metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (previousBundleRestored && hadPreviousBundle) {
    try {
      startAndVerify();
      runtimeRestored = true;
    } catch (error) {
      rollbackErrors.push(`could not restart and verify restored runtime: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!hadPreviousBundle) {
    runtimeRestored = true;
  }

  const rollback = { previousBundleRestored, runtimeStateRestored, runtimeRestored, serviceRestored: runtimeRestored, failedCandidatePath, errors: rollbackErrors };
  const rollbackComplete = previousBundleRestored && runtimeStateRestored && (!hadPreviousBundle || runtimeRestored) && rollbackErrors.length === 0;
  throw new RuntimePublishError(
    `Runtime publication failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}. ` +
      (rollbackComplete ? "The previous runtime was restored and verified." : `Automatic rollback was incomplete: ${rollbackErrors.join("; ") || "previous runtime evidence is incomplete"}.`),
    { cause: primaryError, rollback }
  );
}

module.exports = {
  RuntimePublishError,
  atomicWriteBuffer,
  atomicWriteJson,
  publishRuntimeTransaction,
  snapshotTree,
  stageRuntimeBundle,
  verifyCopiedTree
};
