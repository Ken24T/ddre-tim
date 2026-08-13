#!/usr/bin/env node

const DEFAULT_ADVISER_CONTRACT = Object.freeze({
  name: "tctbp-adviser-inspection",
  major: 1,
  minor: 0,
  capabilities: [
    "inspection.local-v1",
    "workflow-catalogue.core-v1",
    "reason-codes.core-v1"
  ],
  schema: "schemas/tctbp-adviser-inspection-v1.schema.json"
});

const WORKFLOW_IDS = [
  "status",
  "preflight",
  "abort",
  "resume",
  "checkpoint",
  "publish",
  "handover",
  "branch",
  "promote",
  "deploy",
  "ship",
  "hotfix",
  "release",
  "ticket",
  "gate",
  "version",
  "rollback",
  "scaffold",
  "orient"
];

function createStatusDocument(input) {
  validateContractConfiguration(input.config);
  const contract = resolveContract(input.config);
  const reasonCodes = resolveStatusReasonCodes(input);

  return {
    contract,
    observation: {
      provider: "tctbp-web",
      observedAt: input.observedAt || new Date().toISOString(),
      basis: "local-working-copy-and-local-tracking-refs",
      fetchPerformed: input.fetchPerformed === true,
      repository: {
        name: input.config.project && input.config.project.name
          ? input.config.project.name
          : "unknown",
        tctbpSchemaVersion: input.config.schemaVersion || null,
        tctbpVersion: input.versionSource.version,
        versionSource: input.versionSource.path
      },
      branchModel: {
        strategy: input.branchModel.strategy,
        workingBranch: input.branchModel.workingBranch,
        preProductionBranch: input.branchModel.preProductionBranch,
        productionBranch: input.branchModel.productionBranch,
        promotionTargets: input.branchModel.promotionTargets
      },
      head: {
        branch: input.currentBranch === "HEAD" ? null : input.currentBranch,
        detached: input.currentBranch === "HEAD",
        sha: input.currentLocalSha
      },
      workingTree: {
        clean: input.workingTreeSummary.isClean,
        pathCount: input.workingTreeSummary.lines.length,
        counts: input.workingTreeSummary.counts
      },
      operations: [...input.operationStates],
      localTracking: {
        basis: "refs/remotes/origin/*",
        freshness: input.fetchPerformed ? "refreshed-at-observation" : "unknown",
        current: createCurrentTrackingState(input),
        branches: input.branchStates.map((state) =>
          createBranchObservation(state, input.branchModel)
        )
      },
      release: {
        reachableTag: input.localTag,
        publishedTag: input.remoteTag
      },
      continuationFileCount: input.handoverContinuationCount,
      workflows: createWorkflowCatalogue(input.config, input.branchModel),
      statusAdvice: {
        tokens: [...input.recommendations],
        reasonCodes
      },
      activeGuardrails: resolveActiveGuardrails(input)
    },
    errors: []
  };
}

function createStatusErrorDocument(config, error) {
  return {
    contract: resolveContract(config || {}),
    observation: null,
    errors: [
      {
        code: "status-inspection-failed",
        message: normaliseErrorMessage(error)
      }
    ]
  };
}

function resolveContract(config) {
  const configured = config && config.adviserContract;

  if (!configured) {
    return { ...DEFAULT_ADVISER_CONTRACT };
  }

  return {
    name: DEFAULT_ADVISER_CONTRACT.name,
    major: Number.isInteger(configured.major)
      ? configured.major
      : DEFAULT_ADVISER_CONTRACT.major,
    minor: Number.isInteger(configured.minor)
      ? configured.minor
      : DEFAULT_ADVISER_CONTRACT.minor,
    capabilities: Array.isArray(configured.capabilities)
      ? [...configured.capabilities]
      : [...DEFAULT_ADVISER_CONTRACT.capabilities],
    schema: configured.schema || DEFAULT_ADVISER_CONTRACT.schema
  };
}

function validateContractConfiguration(config) {
  const contract = config && config.adviserContract;

  if (
    !contract ||
    !Number.isInteger(contract.major) ||
    !Number.isInteger(contract.minor) ||
    !Array.isArray(contract.capabilities) ||
    contract.capabilities.some((value) => typeof value !== "string")
  ) {
    throw new Error("TCTBP Adviser contract metadata is missing or invalid.");
  }
}

function createCurrentTrackingState(input) {
  return {
    remoteExists: input.currentRemoteExists,
    localSha: input.currentLocalSha,
    remoteSha: input.currentOriginSha,
    sync: normaliseSyncState(input.currentSyncState, input.currentRemoteExists)
  };
}

function createBranchObservation(state, branchModel) {
  return {
    role: resolveBranchRole(state.branchName, branchModel),
    name: state.branchName,
    local: {
      exists: state.localExists,
      sha: state.localSha
    },
    tracking: {
      exists: state.remoteExists,
      sha: state.remoteSha
    },
    sync: normaliseSyncState(state.syncState, state.remoteExists)
  };
}

function normaliseSyncState(syncState, remoteExists) {
  if (!remoteExists || !syncState) {
    return {
      state: "unpublished",
      ahead: 0,
      behind: 0,
      diverged: false
    };
  }

  let state = "in-sync";
  if (syncState.diverged) {
    state = "diverged";
  } else if (syncState.ahead > 0) {
    state = "ahead";
  } else if (syncState.behind > 0) {
    state = "behind";
  }

  return {
    state,
    ahead: syncState.ahead,
    behind: syncState.behind,
    diverged: syncState.diverged
  };
}

function resolveBranchRole(branchName, branchModel) {
  if (branchName === branchModel.workingBranch) {
    return "working";
  }

  if (branchName === branchModel.preProductionBranch) {
    return "pre-production";
  }

  if (branchName === branchModel.productionBranch) {
    return "production";
  }

  return "other";
}

function createWorkflowCatalogue(config, branchModel) {
  return WORKFLOW_IDS.map((id) => {
    const section = id === "status" ? config.statusReport : config[id];
    const strategyAllows =
      id !== "promote" ||
      Boolean(branchModel.workingBranch && branchModel.preProductionBranch);

    return {
      id,
      installed: id === "status" || Boolean(section),
      policyEnabled:
        strategyAllows &&
        Boolean(section) &&
        section.enabled !== false,
      preferredTriggers:
        section && Array.isArray(section.preferredTriggers)
          ? [...section.preferredTriggers]
          : id === "status"
            ? ["status", "status please"]
            : []
    };
  });
}

function resolveStatusReasonCodes(input) {
  return input.recommendations.map((token) => {
    if (token === "abort") return "active-git-operation";
    if (token === "checkpoint") return "working-tree-dirty";
    if (token === "resume") return "branch-behind";
    if (token === "ship") return "ship-ready";
    if (token === "handover") return "handover-ready";
    if (token === "none") return "no-action-required";

    if (token === "publish") {
      return input.currentRemoteExists ? "branch-ahead" : "branch-unpublished";
    }

    if (token === "investigate") {
      if (input.currentBranch === "HEAD") return "detached-head";
      if (input.currentSyncState.diverged) return "branch-diverged";
      if (!input.workingTreeSummary.isClean && input.currentSyncState.behind > 0) {
        return "working-tree-dirty-and-behind";
      }
    }

    return "inspection-required";
  });
}

function resolveActiveGuardrails(input) {
  const guardrails = [];

  if (input.operationStates.length > 0) {
    guardrails.push(guardrail("git.operation.active", "active-git-operation"));
  }

  if (input.currentBranch === "HEAD") {
    guardrails.push(guardrail("git.head.detached", "detached-head"));
  }

  if (input.currentSyncState.diverged) {
    guardrails.push(guardrail("git.branch.diverged", "branch-diverged"));
  }

  if (!input.workingTreeSummary.isClean && input.currentSyncState.behind > 0) {
    guardrails.push(
      guardrail(
        "git.working-tree.dirty-behind",
        "working-tree-dirty-and-behind"
      )
    );
  } else if (!input.workingTreeSummary.isClean) {
    guardrails.push(
      guardrail("git.working-tree.dirty", "working-tree-dirty")
    );
  }

  if (!input.currentSyncState.diverged && input.currentSyncState.behind > 0) {
    guardrails.push(guardrail("git.branch.behind", "branch-behind"));
  }

  if (!input.currentRemoteExists) {
    guardrails.push(
      guardrail("git.branch.unpublished", "branch-unpublished")
    );
  } else if (!input.currentSyncState.diverged && input.currentSyncState.ahead > 0) {
    guardrails.push(guardrail("git.branch.ahead", "branch-ahead"));
  }

  return guardrails;
}

function guardrail(id, reasonCode) {
  return { id, reasonCode };
}

function normaliseErrorMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim() || "Status inspection failed.";
}

module.exports = {
  DEFAULT_ADVISER_CONTRACT,
  WORKFLOW_IDS,
  createStatusDocument,
  createStatusErrorDocument,
  resolveStatusReasonCodes
};
