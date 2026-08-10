"use strict";

const fs = require("fs");
const path = require("path");
const { resolveRepoRoot } = require("./tctbp-runtime");

const RELEASE_STATE_SCHEMA_VERSION = 2;
const RELEASE_STATE_KIND = "tctbp-release-state";
const RELEASE_STATE_RELATIVE_PATH = path.join(".tctbp-runtime", "release-state.json");
const RELEASE_STAGE_ORDER = Object.freeze([
  "preflight-gates",
  "development-deployed",
  "staging-promoted",
  "staging-deployed",
  "production-promoted",
  "shipped",
  "production-deployed",
  "finalized"
]);
const RELEASE_STATUSES = new Set(["in-progress", "paused", "failed", "completed", "cancelled"]);

function readPolicy(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, ".github", "TCTBP.json"), "utf8"));
  } catch (_error) {
    return null;
  }
}

function resolveReleaseSettings(options = {}) {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const config = options.config || options.releaseConfig || readPolicy(repoRoot) || {};
  const configuredValue = config.releaseState ||
    (config.workflow && config.workflow.releaseState) ||
    (config.release && config.release.state) ||
    config;
  const configured = typeof configuredValue === "string" ? { path: configuredValue } : configuredValue;
  const stageOrder = options.stageOrder || configured.stageOrder ||
    (config.workflow && config.workflow.releaseStageOrder) || RELEASE_STAGE_ORDER;
  const relativePath = options.relativePath || configured.path || configured.relativePath ||
    (config.workflow && config.workflow.releaseStatePath) || RELEASE_STATE_RELATIVE_PATH;

  if (!Array.isArray(stageOrder) || stageOrder.length === 0 || stageOrder.some((stage) => typeof stage !== "string" || !stage.trim())) {
    throw new Error("Release stage order must be a non-empty list of names.");
  }

  return {
    kind: options.kind || configured.kind || RELEASE_STATE_KIND,
    relativePath,
    stageOrder: [...stageOrder]
  };
}

function resolveReleaseStatePath(options = {}) {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const settings = resolveReleaseSettings(options);
  return path.resolve(repoRoot, settings.relativePath);
}

function isoTimestamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("Release state timestamp is invalid.");
  return date.toISOString();
}

function createWorkflowId(version, now = new Date()) {
  const safeVersion = String(version || "").trim().replace(/[^0-9A-Za-z.-]+/g, "-");
  if (!safeVersion) throw new Error("Release workflow requires a version.");
  return `release-${safeVersion}-${isoTimestamp(now).replace(/[-:.]/g, "")}`;
}

function createReleaseState({
  version,
  docsNoteKind,
  docsNote,
  stopAt = "production",
  originalBranch,
  workflowId = null,
  now = new Date(),
  config,
  releaseConfig,
  stageOrder,
  kind
}) {
  if (!version || !docsNoteKind || !docsNote || !originalBranch) {
    throw new Error("Release state requires version, docs impact, and original branch.");
  }

  const settings = resolveReleaseSettings({ config, releaseConfig, stageOrder, kind });
  const timestamp = isoTimestamp(now);
  const state = {
    schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
    kind: settings.kind,
    workflowId: workflowId || createWorkflowId(version, now),
    status: "in-progress",
    version: String(version),
    options: { docsNoteKind, docsNote, stopAt },
    originalBranch,
    createdAt: timestamp,
    updatedAt: timestamp,
    currentStage: null,
    lastCompletedStage: null,
    completedStages: {},
    failure: null,
    stageOrder: settings.stageOrder
  };

  return state;
}

function migrateReleaseState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || state.schemaVersion !== 1) return state;
  const migrated = JSON.parse(JSON.stringify(state));
  migrated.schemaVersion = RELEASE_STATE_SCHEMA_VERSION;
  return migrated;
}

function stageOrderFor(state, options = {}) {
  return resolveReleaseSettings({
    ...options,
    stageOrder: options.stageOrder || state.stageOrder || undefined,
    kind: options.kind || (state.kind === RELEASE_STATE_KIND ? undefined : options.kind)
  }).stageOrder;
}

function validateReleaseState(state, options = {}) {
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) return ["release state is missing or is not an object"];
  const settings = resolveReleaseSettings({
    ...options,
    stageOrder: options.stageOrder || state.stageOrder || undefined,
    kind: options.kind || (state.stageOrder ? state.kind : undefined)
  });
  const stages = settings.stageOrder;

  if (state.schemaVersion !== RELEASE_STATE_SCHEMA_VERSION) errors.push(`unsupported release state schema ${String(state.schemaVersion)}`);
  if (state.kind !== settings.kind) errors.push("release state kind is invalid");
  if (typeof state.workflowId !== "string" || !state.workflowId.trim()) errors.push("release workflow ID is missing");
  if (!RELEASE_STATUSES.has(state.status)) errors.push(`release status '${String(state.status)}' is invalid`);
  if (typeof state.version !== "string" || !state.version.trim()) errors.push("release version is missing");
  if (!state.options || typeof state.options !== "object") errors.push("release options are missing");
  if (typeof state.originalBranch !== "string" || !state.originalBranch.trim()) errors.push("original branch is missing");
  if (!Number.isFinite(Date.parse(state.createdAt))) errors.push("release createdAt is invalid");
  if (!Number.isFinite(Date.parse(state.updatedAt))) errors.push("release updatedAt is invalid");
  if (state.currentStage !== null && !stages.includes(state.currentStage)) errors.push(`current release stage '${state.currentStage}' is invalid`);
  if (state.lastCompletedStage !== null && !stages.includes(state.lastCompletedStage)) errors.push(`last completed release stage '${state.lastCompletedStage}' is invalid`);

  if (!state.completedStages || typeof state.completedStages !== "object" || Array.isArray(state.completedStages)) {
    errors.push("completed release stages are invalid");
  } else {
    let missingEarlierStage = false;
    for (const stage of stages) {
      const entry = state.completedStages[stage];
      if (!entry) {
        missingEarlierStage = true;
        continue;
      }
      if (missingEarlierStage) errors.push(`completed release stage '${stage}' skips an earlier stage`);
      if (!Number.isFinite(Date.parse(entry.completedAt))) errors.push(`release stage '${stage}' has an invalid completedAt`);
    }
    for (const stage of Object.keys(state.completedStages)) {
      if (!stages.includes(stage)) errors.push(`unknown completed release stage '${stage}'`);
    }
  }

  return [...new Set(errors)];
}

function requireValidState(state, options = {}) {
  const errors = validateReleaseState(state, options);
  if (errors.length > 0) throw new Error(`Release state is invalid: ${errors.join("; ")}.`);
  return state;
}

function cloneState(state, options = {}) {
  return JSON.parse(JSON.stringify(requireValidState(state, options)));
}

function stageIndex(stage, options = {}) {
  const index = resolveReleaseSettings(options).stageOrder.indexOf(stage);
  if (index < 0) throw new Error(`Unknown release stage '${stage}'.`);
  return index;
}

function isStageComplete(state, stage, options = {}) {
  requireValidState(state, options);
  stageIndex(stage, { ...options, stageOrder: options.stageOrder || state.stageOrder });
  return Boolean(state.completedStages[stage]);
}

function getStageEvidence(state, stage, options = {}) {
  requireValidState(state, options);
  stageIndex(stage, { ...options, stageOrder: options.stageOrder || state.stageOrder });
  const entry = state.completedStages[stage];
  return entry ? JSON.parse(JSON.stringify(entry.evidence || {})) : null;
}

function nextIncompleteStage(state, options = {}) {
  requireValidState(state, options);
  const stages = stageOrderFor(state, options);
  return stages.find((stage) => !state.completedStages[stage]) || null;
}

function markStageStarted(state, stage, now = new Date(), options = {}) {
  const next = cloneState(state, options);
  const stages = stageOrderFor(next, options);
  stageIndex(stage, { ...options, stageOrder: stages });
  if (next.status === "completed" || next.status === "cancelled") throw new Error(`Cannot start stage '${stage}' while release is ${next.status}.`);
  const expected = nextIncompleteStage(next, options);
  if (expected !== stage && !next.completedStages[stage]) throw new Error(`Cannot start stage '${stage}'; next incomplete stage is '${expected}'.`);
  next.status = "in-progress";
  next.currentStage = stage;
  next.failure = null;
  next.updatedAt = isoTimestamp(now);
  return next;
}

function markStageCompleted(state, stage, evidence = {}, now = new Date(), options = {}) {
  const next = cloneState(state, options);
  const stages = stageOrderFor(next, options);
  const index = stageIndex(stage, { ...options, stageOrder: stages });
  for (let earlier = 0; earlier < index; earlier += 1) {
    const required = stages[earlier];
    if (!next.completedStages[required]) throw new Error(`Cannot complete stage '${stage}' before '${required}'.`);
  }
  const completedAt = isoTimestamp(now);
  next.completedStages[stage] = { completedAt, evidence: evidence && typeof evidence === "object" ? evidence : {} };
  next.lastCompletedStage = stage;
  next.currentStage = null;
  next.failure = null;
  next.updatedAt = completedAt;
  next.status = stage === stages[stages.length - 1] ? "completed" : "in-progress";
  return next;
}

function markReleasePaused(state, reason, now = new Date(), options = {}) {
  const next = cloneState(state, options);
  next.status = "paused";
  next.updatedAt = isoTimestamp(now);
  next.failure = reason ? { stage: next.currentStage, at: next.updatedAt, message: String(reason) } : null;
  return next;
}

function markReleaseFailed(state, stage, error, now = new Date(), options = {}) {
  const next = cloneState(state, options);
  stageIndex(stage, { ...options, stageOrder: stageOrderFor(next, options) });
  next.status = "failed";
  next.currentStage = stage;
  next.updatedAt = isoTimestamp(now);
  next.failure = { stage, at: next.updatedAt, message: error instanceof Error ? error.message : String(error) };
  return next;
}

function buildResumePlan(state, options = {}) {
  requireValidState(state, options);
  const stages = stageOrderFor(state, options);
  const nextStage = nextIncompleteStage(state, options);
  return {
    workflowId: state.workflowId,
    status: state.status,
    version: state.version,
    completedStages: stages.filter((stage) => state.completedStages[stage]),
    nextStage,
    resumable: nextStage !== null && !["completed", "cancelled"].includes(state.status)
  };
}

function readReleaseState(filePath, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read release state at ${filePath}: ${error.message}`);
  }
  return requireValidState(migrateReleaseState(parsed), options);
}

function writeReleaseStateAtomic(filePath, state, options = {}) {
  requireValidState(state, options);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return filePath;
}

module.exports = {
  RELEASE_STAGE_ORDER,
  RELEASE_STATE_KIND,
  RELEASE_STATE_RELATIVE_PATH,
  RELEASE_STATE_SCHEMA_VERSION,
  buildResumePlan,
  createReleaseState,
  createWorkflowId,
  getStageEvidence,
  isStageComplete,
  markReleaseFailed,
  markReleasePaused,
  markStageCompleted,
  markStageStarted,
  migrateReleaseState,
  nextIncompleteStage,
  readReleaseState,
  resolveReleaseSettings,
  resolveReleaseStatePath,
  validateReleaseState,
  writeReleaseStateAtomic
};
