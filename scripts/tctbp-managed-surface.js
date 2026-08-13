"use strict";

/**
 * scripts/tctbp-managed-surface.js
 *
 * Shared managed-surface manifest for the TCTBP-Web distribution system
 * (Phase 4 of the ecosystem consolidation plan).
 *
 * This module is the single source of truth for:
 *   - which runner / GitHub / prompt / contract files scaffold copies into a
 *     new project (and therefore what reconcile/upgrade must manage);
 *   - the canonical activation trigger surface generated into new profiles;
 *   - the full managed surface used for `.tctbp/source.json` metadata.
 *
 * Consumers: `tctbp-run-scaffold.js`, `tctbp-scaffold-profile.js`, the
 * consistency test suite, and (in later phases) reconcile and Adviser
 * upgrade planning.
 */

/**
 * Runner/support files copied from the canonical `scripts/` directory.
 * `package.json` pins CommonJS for the runner scripts in ESM consumers.
 */
const RUNNER_FILES = [
  "package.json",
  "tctbp-runtime.js",
  "tctbp-core.js",
  "tctbp-branch-model.js",
  "tctbp-json-output.js",
  "tctbp-status-model.js",
  "tctbp-git-ops.js",
  "tctbp-profile-io.js",
  "tctbp-output.js",
  "tctbp-gates.js",
  "tctbp-candidate-guard.js",
  "tctbp-promotion-safety.js",
  "tctbp-release-state.js",
  "tctbp-release-resume.js",
  "tctbp-runtime-transaction.js",
  "tctbp-pretool-hook.js",
  "tctbp-managed-surface.js",
  "tctbp-workflow-catalogue.js",
  "tctbp-run-status.js",
  "tctbp-run-checkpoint.js",
  "tctbp-run-preflight.js",
  "tctbp-run-publish.js",
  "tctbp-run-handover.js",
  "tctbp-run-hotfix.js",
  "tctbp-run-resume.js",
  "tctbp-run-ship.js",
  "tctbp-run-branch.js",
  "tctbp-run-promote.js",
  "tctbp-run-deploy.js",
  "tctbp-run-abort.js",
  "tctbp-run-gate.js",
  "tctbp-run-version.js",
  "version-status.mjs",
  "version-status-policy.mjs",
  "tctbp-run-rollback.js",
  "tctbp-run-runtime-advisory.js",
  "tctbp-run-orient.js",
  "tctbp-run-workflow.js",
  "tctbp-run-release.js",
  "tctbp-run-ticket.js",
  "tctbp-status-report.js",
  "tctbp-scaffold-cli.js",
  "tctbp-scaffold-profile.js"
];

/** GitHub files copied from the canonical `.github/` directory. */
const GITHUB_FILES = [
  "agents/TCTBP.agent.md",
  "TCTBP Agent.md",
  "TCTBP Cheatsheet.md",
  "hooks/tctbp-safety.json"
];

/** Prompt files copied from the canonical `.github/prompts/` directory. */
const PROMPT_FILES = [
  "Install TCTBP Agent Infrastructure Into Another Repository.prompt.md",
  "Scaffold New TCTBP-Web Project.prompt.md"
];

/** Adviser contract files copied from the repository root. */
const CONTRACT_FILES = [
  "schemas/tctbp-adviser-inspection-v1.schema.json",
  "contracts/adviser-v1/fixtures/simple-clean.json",
  "contracts/adviser-v1/fixtures/staged-dirty.json",
  "contracts/adviser-v1/fixtures/long-lived-diverged.json",
  "docs/adviser-contract-v1.md"
];

/**
 * Canonical activation trigger surface generated into new project profiles.
 * Mirrors the public workflow catalogue (`tctbp-workflow-catalogue.js`).
 */
const ACTIVATION_TRIGGERS = [
  "ship", "ship please", "shipping",
  "release", "release please", "prepare release", "prepare release please",
  "checkpoint", "checkpoint please",
  "publish", "publish please",
  "promote", "promote please", "promote staging", "promote staging please",
  "promote review", "promote review please",
  "promote production", "promote production please", "promote prod", "promote prod please",
  "deploy", "deploy please", "deploy dev", "deploy dev please",
  "deploy development", "deploy development please",
  "deploy review", "deploy review please",
  "deploy staging", "deploy staging please",
  "deploy prod", "deploy prod please", "deploy production", "deploy production please",
  "handover", "handover please", "handover local", "handover local please",
  "resume", "resume please", "orient", "orient please",
  "status", "status please", "preflight", "preflight please", "abort",
  "run tests", "run lint", "run build", "gate test", "gate lint", "gate build",
  "ticket create", "ticket report", "ticket triage",
  "version status", "version check",
  "rollback", "revert last checkpoint",
  "hotfix", "hotfix please", "hotfix start", "hotfix start please",
  "hotfix finish", "hotfix finish please",
  "emergency fix", "emergency fix please"
];

/**
 * Full managed surface as repo-relative paths, used by `.tctbp/source.json`
 * and upgrade/drift assessment.
 */
const MANAGED_SURFACE = [
  ...RUNNER_FILES.map((file) => `scripts/${file}`),
  ...GITHUB_FILES.map((file) => `.github/${file}`),
  ...PROMPT_FILES.map((file) => `.github/prompts/${file}`),
  ...CONTRACT_FILES
];

/**
 * Build the `.tctbp/source.json` metadata document for a scaffolded project.
 *
 * @param {object} input
 * @param {string} input.sourceRepository   e.g. "Ken24T/TCTBP-Web"
 * @param {string} input.sourceRevision     source git revision used
 * @param {string} input.sourceVersion      source version (e.g. "0.3.6")
 * @param {number} input.schemaVersion      TCTBP profile schema version
 * @param {object} input.adviserContract    adviser contract metadata
 * @param {string} [input.installedAt]      ISO date; defaults to today
 * @returns {object} source metadata document
 */
function createSourceMetadata({
  sourceRepository,
  sourceRevision,
  sourceVersion,
  schemaVersion,
  adviserContract,
  installedAt
}) {
  return {
    sourceRepository,
    sourceRevision,
    sourceVersion,
    installedSchemaVersion: schemaVersion,
    adviserContract,
    managedSurface: MANAGED_SURFACE,
    installedAt: installedAt || new Date().toISOString().slice(0, 10)
  };
}

module.exports = {
  RUNNER_FILES,
  GITHUB_FILES,
  PROMPT_FILES,
  CONTRACT_FILES,
  ACTIVATION_TRIGGERS,
  MANAGED_SURFACE,
  createSourceMetadata
};
