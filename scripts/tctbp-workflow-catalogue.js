"use strict";

/**
 * scripts/tctbp-workflow-catalogue.js
 *
 * Canonical machine-readable workflow catalogue for the TCTBP-Web runtime,
 * introduced by Phase 2 (consistency hardening) of the ecosystem
 * consolidation plan (docs/plans/tctbp-ecosystem-consolidation.md).
 *
 * The catalogue is the single source of truth for:
 *   - which workflows are public vs internal;
 *   - each public workflow's canonical trigger/alias set;
 *   - the runner path that implements it;
 *   - whether the runner belongs to the scaffold-managed surface;
 *   - which agent-facing surfaces must recognise the workflow.
 *
 * `auditCatalogue()` cross-checks the catalogue against the live
 * `.github/TCTBP.json` profile plus the scaffold runner inventory and the
 * agent activation frontmatter, returning a structured violation list.
 *
 * The test suite (`test/tctbp-workflow-catalogue.test.js`) pins the currently
 * known violation set (D1-D7 from the Phase 1 audit matrix) so that:
 *   - the validator demonstrably catches the documented discrepancies, and
 *   - Phase 3 semantic fixes must update the pin together with the code.
 *
 * This module performs no I/O; callers pass the profile and optional
 * surface data (scaffold inventory, agent frontmatter, existing runners).
 */

const path = require("node:path");

/**
 * Canonical public workflow catalogue.
 *
 * Field reference:
 *   id                stable workflow identifier
 *   displayName       human-readable name
 *   runner            repo-relative runner path, or null when not yet implemented
 *   aliases           canonical public trigger phrases (lowercase)
 *   scaffoldManaged   whether scaffold must copy the runner file
 *   agentToken        token expected in the agent activation frontmatter
 *   adviserVocab      whether the workflow belongs in adviserVocabulary.workflowIds
 *   viaBranchCommand  when true the workflow is triggered by the branchCommand pattern
 */
const PUBLIC_WORKFLOWS = [
  {
    id: "status",
    displayName: "Status",
    runner: "scripts/tctbp-run-status.js",
    aliases: ["status", "status please"],
    scaffoldManaged: true,
    agentToken: "status",
    adviserVocab: true,
  },
  {
    id: "preflight",
    displayName: "Preflight",
    runner: "scripts/tctbp-run-preflight.js",
    aliases: ["preflight", "preflight please"],
    scaffoldManaged: true,
    agentToken: "preflight",
    adviserVocab: true,
  },
  {
    id: "checkpoint",
    displayName: "Checkpoint",
    runner: "scripts/tctbp-run-checkpoint.js",
    aliases: ["checkpoint", "checkpoint please"],
    scaffoldManaged: true,
    agentToken: "checkpoint",
    adviserVocab: true,
  },
  {
    id: "publish",
    displayName: "Publish",
    runner: "scripts/tctbp-run-publish.js",
    aliases: ["publish", "publish please"],
    scaffoldManaged: true,
    agentToken: "publish",
    adviserVocab: true,
  },
  {
    id: "handover",
    displayName: "Handover",
    runner: "scripts/tctbp-run-handover.js",
    aliases: [
      "handover",
      "handover please",
      "handover local",
      "handover local please",
    ],
    scaffoldManaged: true,
    agentToken: "handover",
    adviserVocab: true,
  },
  {
    id: "resume",
    displayName: "Resume",
    runner: "scripts/tctbp-run-resume.js",
    aliases: ["resume", "resume please"],
    scaffoldManaged: true,
    agentToken: "resume",
    adviserVocab: true,
  },
  {
    id: "orient",
    displayName: "Orient",
    runner: "scripts/tctbp-run-orient.js",
    aliases: ["orient", "orient please"],
    scaffoldManaged: true,
    agentToken: "orient",
    adviserVocab: true,
  },
  {
    id: "branch",
    displayName: "Branch",
    runner: "scripts/tctbp-run-branch.js",
    aliases: [],
    viaBranchCommand: true,
    scaffoldManaged: true,
    agentToken: "branch",
    adviserVocab: true,
  },
  {
    id: "promote",
    displayName: "Promote",
    runner: "scripts/tctbp-run-promote.js",
    aliases: [
      "promote",
      "promote please",
      "promote staging",
      "promote staging please",
      "promote review",
      "promote review please",
      "promote production",
      "promote production please",
      "promote prod",
      "promote prod please",
    ],
    scaffoldManaged: true,
    agentToken: "promote",
    adviserVocab: true,
  },
  {
    id: "deploy",
    displayName: "Deploy",
    runner: "scripts/tctbp-run-deploy.js",
    aliases: [
      "deploy",
      "deploy please",
      "deploy dev",
      "deploy dev please",
      "deploy development",
      "deploy development please",
      "deploy review",
      "deploy review please",
      "deploy staging",
      "deploy staging please",
      "deploy prod",
      "deploy prod please",
      "deploy production",
      "deploy production please",
    ],
    scaffoldManaged: true,
    agentToken: "deploy",
    adviserVocab: true,
  },
  {
    id: "ship",
    displayName: "Ship",
    runner: "scripts/tctbp-run-ship.js",
    aliases: ["ship", "ship please", "shipping"],
    scaffoldManaged: true,
    agentToken: "ship",
    adviserVocab: true,
  },
  {
    id: "release",
    displayName: "Release",
    runner: "scripts/tctbp-run-release.js",
    aliases: [
      "release",
      "release please",
      "prepare release",
      "prepare release please",
    ],
    scaffoldManaged: true,
    agentToken: "release",
    adviserVocab: true,
  },
  {
    id: "hotfix",
    displayName: "Hotfix",
    runner: "scripts/tctbp-run-hotfix.js",
    aliases: [
      "hotfix",
      "hotfix please",
      "hotfix start",
      "hotfix start please",
      "hotfix finish",
      "hotfix finish please",
      "emergency fix",
      "emergency fix please",
    ],
    scaffoldManaged: true,
    agentToken: "hotfix",
    adviserVocab: true,
  },
  {
    id: "gate",
    displayName: "Gate",
    runner: "scripts/tctbp-run-gate.js",
    aliases: ["run tests", "run lint", "run build", "gate test", "gate lint", "gate build"],
    scaffoldManaged: true,
    agentToken: "gate",
    adviserVocab: true,
  },
  {
    id: "version",
    displayName: "Version",
    runner: "scripts/tctbp-run-version.js",
    aliases: ["version status", "version check"],
    scaffoldManaged: true,
    agentToken: "version",
    adviserVocab: true,
  },
  {
    id: "rollback",
    displayName: "Rollback",
    runner: "scripts/tctbp-run-rollback.js",
    aliases: ["rollback", "revert last checkpoint"],
    scaffoldManaged: true,
    agentToken: "rollback",
    adviserVocab: true,
  },
  {
    id: "abort",
    displayName: "Abort",
    runner: "scripts/tctbp-run-abort.js",
    aliases: ["abort"],
    scaffoldManaged: true,
    agentToken: "abort",
    adviserVocab: true,
  },
  {
    id: "ticket",
    displayName: "Ticket",
    runner: "scripts/tctbp-run-ticket.js",
    aliases: ["ticket create", "ticket report", "ticket triage"],
    scaffoldManaged: true,
    agentToken: "ticket",
    adviserVocab: true,
  },
  {
    id: "scaffold",
    displayName: "Scaffold",
    runner: "scripts/tctbp-run-scaffold.js",
    aliases: [
      "scaffold",
      "scaffold please",
      "scaffold web",
      "scaffold web please",
      "new project",
      "create project",
    ],
    // Scaffold is the factory itself; it copies the runtime into new projects
    // but does not copy its own runner, so it is not scaffold-managed.
    scaffoldManaged: false,
    agentToken: "scaffold",
    adviserVocab: true,
  },
];

/**
 * Internal infrastructure. These must never be advertised as public
 * activation triggers. `aliases` is intentionally empty.
 */
const INTERNAL_WORKFLOWS = [
  {
    id: "workflow",
    displayName: "Workflow dispatcher",
    runner: "scripts/tctbp-run-workflow.js",
    aliases: [],
    note: "Internal dispatcher routing to sub-runners; not a public trigger.",
  },
];

function allWorkflows() {
  return [...PUBLIC_WORKFLOWS, ...INTERNAL_WORKFLOWS];
}

/**
 * Build the alias -> workflowId ownership map across the whole catalogue.
 * Returns Map<string, string> (lowercase alias keyed).
 */
function buildOwnerMap() {
  const ownerByAlias = new Map();
  for (const workflow of allWorkflows()) {
    for (const alias of workflow.aliases) {
      const key = String(alias).toLowerCase();
      if (!ownerByAlias.has(key)) {
        ownerByAlias.set(key, workflow.id);
      }
    }
  }
  return ownerByAlias;
}

/**
 * Resolve a trigger phrase to a workflow id, or null when unknown.
 * Branch triggers are resolved via the branchCommand pattern.
 */
function resolveWorkflowForTrigger(trigger, profile = {}) {
  const key = String(trigger).toLowerCase();
  const ownerByAlias = buildOwnerMap();
  if (ownerByAlias.has(key)) {
    return ownerByAlias.get(key);
  }
  const branchCommand =
    profile.activation && profile.activation.branchCommand
      ? profile.activation.branchCommand
      : {};
  if (branchCommand.enabled && branchCommand.pattern) {
    try {
      if (new RegExp(branchCommand.pattern).test(key)) {
        return "branch";
      }
    } catch {
      // ignore malformed pattern; treated as unresolvable
    }
  }
  return null;
}

/**
 * Cross-check the catalogue against the live profile and surface data.
 *
 * options:
 *   scaffoldRunnerFiles   basenames listed in the scaffold RUNNER_FILES inventory
 *   agentFrontmatter      text of the agent activation frontmatter
 *   existingRunners       basenames of runner files present in scripts/
 *
 * Returns an array of { workflowId, code, message } violations.
 */
function auditCatalogue(profile, options = {}) {
  const {
    scaffoldRunnerFiles = [],
    agentFrontmatter = "",
    existingRunners = [],
  } = options;

  const violations = [];
  const activation = profile.activation || {};
  const triggers = Array.isArray(activation.triggers) ? activation.triggers : [];
  const normalizedTriggers = new Set(
    triggers.map((trigger) => String(trigger).toLowerCase())
  );
  const branchEnabled = !!(activation.branchCommand && activation.branchCommand.enabled);
  const vocab = (profile.adviserVocabulary && profile.adviserVocabulary.workflowIds) || [];
  const vocabSet = new Set(vocab);

  const ownerByAlias = new Map();
  for (const workflow of allWorkflows()) {
    for (const alias of workflow.aliases) {
      const key = String(alias).toLowerCase();
      if (ownerByAlias.has(key)) {
        violations.push({
          workflowId: workflow.id,
          code: "duplicate-owner",
          message: `alias "${key}" is also owned by "${ownerByAlias.get(key)}"`,
        });
      } else {
        ownerByAlias.set(key, workflow.id);
      }
    }
  }

  // Every activation trigger must resolve to exactly one known workflow.
  for (const trigger of triggers) {
    const key = String(trigger).toLowerCase();
    if (!ownerByAlias.has(key) && !(branchEnabled && isBranchPatternMatch(key, activation))) {
      violations.push({
        workflowId: null,
        code: "unknown-trigger",
        message: `activation trigger "${key}" is not owned by any workflow in the catalogue`,
      });
    }
  }

  for (const workflow of PUBLIC_WORKFLOWS) {
    // Alias-to-activation consistency.
    if (!workflow.viaBranchCommand) {
      const missing = workflow.aliases.filter(
        (alias) => !normalizedTriggers.has(alias.toLowerCase())
      );
      if (missing.length > 0) {
        violations.push({
          workflowId: workflow.id,
          code: "alias-not-activated",
          message: `workflow "${workflow.id}" aliases not activated: ${missing.join(", ")}`,
        });
      }
    } else if (!branchEnabled) {
      violations.push({
        workflowId: workflow.id,
        code: "branch-command-disabled",
        message: `workflow "${workflow.id}" is pattern-triggered but activation.branchCommand.enabled is false`,
      });
    }

    // Runner existence.
    if (workflow.runner) {
      const basename = path.basename(workflow.runner);
      if (!existingRunners.includes(basename)) {
        violations.push({
          workflowId: workflow.id,
          code: "runner-missing",
          message: `runner "${basename}" for workflow "${workflow.id}" does not exist`,
        });
      }
    }

    // Scaffold managed-surface consistency.
    if (workflow.scaffoldManaged && workflow.runner) {
      const basename = path.basename(workflow.runner);
      if (!scaffoldRunnerFiles.includes(basename)) {
        violations.push({
          workflowId: workflow.id,
          code: "scaffold-surface-gap",
          message: `runner "${basename}" for workflow "${workflow.id}" is missing from the scaffold RUNNER_FILES inventory`,
        });
      }
    }

    // Agent activation frontmatter coverage.
    if (workflow.agentToken) {
      const token = workflow.agentToken.toLowerCase();
      if (!agentFrontmatter.toLowerCase().includes(token)) {
        violations.push({
          workflowId: workflow.id,
          code: "agent-frontmatter-gap",
          message: `agent activation frontmatter does not mention "${workflow.agentToken}"`,
        });
      }
    }

    // Adviser vocabulary coverage.
    if (workflow.adviserVocab && !vocabSet.has(workflow.id)) {
      violations.push({
        workflowId: workflow.id,
        code: "adviser-vocab-gap",
        message: `workflow "${workflow.id}" is missing from adviserVocabulary.workflowIds`,
      });
    }
  }

  // Adviser vocabulary must only contain known public workflows.
  const publicIds = new Set(PUBLIC_WORKFLOWS.map((workflow) => workflow.id));
  for (const id of vocab) {
    if (!publicIds.has(id)) {
      violations.push({
        workflowId: id,
        code: "adviser-vocab-unknown",
        message: `adviserVocabulary.workflowIds contains unknown workflow "${id}"`,
      });
    }
  }

  // Profile workflow sections must own exactly their catalogue triggers.
  for (const [sectionId, section] of Object.entries(profile)) {
    if (section && Array.isArray(section.preferredTriggers)) {
      for (const trigger of section.preferredTriggers) {
        const key = String(trigger).toLowerCase();
        const owner = ownerByAlias.get(key);
        if (owner && owner !== sectionId) {
          violations.push({
            workflowId: sectionId,
            code: "section-trigger-mismatch",
            message: `section "${sectionId}" owns trigger "${key}" which the catalogue assigns to "${owner}"`,
          });
        }
      }
    }
  }

  return violations;
}

function isBranchPatternMatch(key, activation) {
  const pattern = activation.branchCommand && activation.branchCommand.pattern;
  if (!pattern) {
    return false;
  }
  try {
    return new RegExp(pattern).test(key);
  } catch {
    return false;
  }
}

module.exports = {
  PUBLIC_WORKFLOWS,
  INTERNAL_WORKFLOWS,
  allWorkflows,
  buildOwnerMap,
  resolveWorkflowForTrigger,
  auditCatalogue,
};
