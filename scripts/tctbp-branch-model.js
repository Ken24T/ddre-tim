#!/usr/bin/env node

function resolveBranchModel(config = {}) {
  const branchModel = config.branchModel || {};
  const strategy = branchModel.strategy || "simple";
  const configuredStrategy =
    branchModel.strategies && branchModel.strategies[strategy]
      ? branchModel.strategies[strategy]
      : {};
  const active = { ...configuredStrategy, ...branchModel };
  const productionBranch =
    active.productionBranch ||
    (config.project && config.project.defaultBranch) ||
    "main";

  let workingBranch = null;
  let stagingBranch = null;
  let reviewBranch = null;

  if (strategy === "staged") {
    workingBranch = active.workingBranch || "development";
    stagingBranch = active.stagingBranch || "staging";
  } else if (strategy === "long-lived-environment-branches") {
    workingBranch = active.workingBranch || "development";
    reviewBranch = active.reviewBranch || "review";
  }

  const preProductionBranch = stagingBranch || reviewBranch;
  const promotionTargets = preProductionBranch
    ? [preProductionBranch, "production"]
    : [];
  const significantBranches = [
    workingBranch,
    preProductionBranch,
    productionBranch
  ].filter(
    (value, index, values) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      values.indexOf(value) === index
  );

  return {
    strategy,
    workingBranch,
    stagingBranch,
    reviewBranch,
    preProductionBranch,
    productionBranch,
    promotionTargets,
    significantBranches
  };
}

module.exports = {
  resolveBranchModel
};
