"use strict";

const {
  buildResumePlan,
  getStageEvidence,
  isStageComplete,
  resolveReleaseSettings
} = require("./tctbp-release-state");

const DEFAULT_CANDIDATE_STAGES = Object.freeze({
  development: { stage: "preflight-gates", evidenceKey: "developmentCandidate", branch: "development" },
  staging: { stage: "staging-promoted", evidenceKey: "stagingCandidate", branch: "staging" },
  production: { stage: "production-promoted", evidenceKey: "productionCandidate", branch: "main" }
});

function requireCandidateEvidence(state, stage, key, branch, options = {}) {
  const evidence = getStageEvidence(state, stage, options);
  const candidate = evidence && evidence[key];

  if (!candidate || !/^[0-9a-f]{40,64}$/i.test(String(candidate.commit || "")) || !/^[0-9a-f]{40,64}$/i.test(String(candidate.tree || ""))) {
    throw new Error(`Release journal stage '${stage}' is missing valid ${key} evidence.`);
  }

  return { branch, commit: candidate.commit.toLowerCase(), tree: candidate.tree.toLowerCase() };
}

function resolveCandidateStages(options = {}) {
  const configured = options.candidateStages ||
    (options.config && options.config.releaseState && options.config.releaseState.candidateStages) ||
    {};
  return Object.fromEntries(Object.entries(DEFAULT_CANDIDATE_STAGES).map(([name, defaults]) => [
    name,
    { ...defaults, ...(configured[name] || {}) }
  ]));
}

function buildResumeEvidencePlan(state, options = {}) {
  const resume = buildResumePlan(state, options);
  const checks = [];
  const candidates = { development: null, staging: null, production: null };

  if (!resume.resumable) return { resume, checks, candidates };

  const candidateStages = resolveCandidateStages(options);
  const stages = resolveReleaseSettings({ ...options, stageOrder: options.stageOrder || state.stageOrder }).stageOrder;
  for (const [name, definition] of Object.entries(candidateStages)) {
    const stage = name === "production" && stages.includes("shipped") && isStageComplete(state, "shipped", options)
      ? "shipped"
      : definition.stage;
    if (stages.includes(stage) && isStageComplete(state, stage, options)) {
      candidates[name] = requireCandidateEvidence(
        state,
        stage,
        definition.evidenceKey,
        definition.branch,
        options
      );
    }
  }

  const productionCandidate = candidates.production;
  const stagingCandidate = candidates.staging;
  const developmentCandidate = candidates.development;
  const shipped = stages.includes("shipped") && isStageComplete(state, "shipped", options);

  if (productionCandidate) {
    checks.push({ type: "candidate", candidate: productionCandidate, requireRemoteSync: shipped });
    if (shipped) checks.push({ type: "tag", version: state.version, candidate: productionCandidate });
  } else if (stagingCandidate) {
    checks.push({ type: "candidate", candidate: stagingCandidate, requireRemoteSync: true });
  } else if (developmentCandidate) {
    checks.push({ type: "candidate", candidate: developmentCandidate, requireRemoteSync: true });
  }

  const runtimeStages = [
    { name: "production", stage: "production-deployed", candidate: productionCandidate },
    { name: "staging", stage: "staging-deployed", candidate: stagingCandidate },
    { name: "development", stage: "development-deployed", candidate: developmentCandidate }
  ];
  const runtime = runtimeStages.find(({ stage, candidate }) => {
    const followingStage = stage === "development-deployed"
      ? "staging-promoted"
      : stage === "staging-deployed"
        ? "production-promoted"
        : "finalized";
    return candidate && stages.includes(stage) && isStageComplete(state, stage, options) && stages.includes(followingStage) && !isStageComplete(state, followingStage, options);
  });

  if (runtime) checks.push({ type: "runtime", target: runtime.name, candidate: runtime.candidate });

  return { resume, checks, candidates };
}

module.exports = {
  DEFAULT_CANDIDATE_STAGES,
  buildResumeEvidencePlan,
  requireCandidateEvidence,
  resolveCandidateStages
};
