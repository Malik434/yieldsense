import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDecision } from "./decisionEngine.js";

test("evaluateDecision blocks when gas is above cap", () => {
  const result = evaluateDecision({
    apr: 0.22,
    tvlUsd: 10000,
    feeRate: 0.003,
    elapsedSec: 3600,
    gasCostUsd: 100,
    efficiencyMultiplier: 1.5,
    minNetRewardUsd: 1,
    maxGasUsd: 30,
    cooldownSec: 300,
    secondsSinceLastExecution: 9999,
    apiFailureStreak: 0,
    maxFailureStreak: 3,
  });
  assert.equal(result.shouldExecute, false);
  assert.equal(result.reason, "gas_too_high");
});

test("evaluateDecision allows profitable execution", () => {
  const result = evaluateDecision({
    apr: 1.2,
    tvlUsd: 10000,
    feeRate: 0.003,
    elapsedSec: 24 * 3600,
    gasCostUsd: 4,
    efficiencyMultiplier: 1.5,
    minNetRewardUsd: 1,
    maxGasUsd: 30,
    cooldownSec: 300,
    secondsSinceLastExecution: 9999,
    apiFailureStreak: 0,
    maxFailureStreak: 3,
  });
  assert.equal(result.shouldExecute, true);
  assert.equal(result.reason, "profitable");
});
