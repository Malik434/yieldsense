import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDecision, calculateAdaptiveIntervalMs } from "./decisionEngine.js";

// --- TC_DEC_01 ---
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

// --- TC_DEC_03 ---
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

// --- TC_DEC_02 ---
test("evaluateDecision blocks when net reward is below minimum", () => {
  const result = evaluateDecision({
    apr: 0.01,
    tvlUsd: 100,
    feeRate: 0.003,
    elapsedSec: 3600,
    gasCostUsd: 1,
    efficiencyMultiplier: 0.5,
    minNetRewardUsd: 50,
    maxGasUsd: 30,
    cooldownSec: 300,
    secondsSinceLastExecution: 9999,
    apiFailureStreak: 0,
    maxFailureStreak: 3,
  });
  assert.equal(result.shouldExecute, false);
  assert.equal(result.reason, "min_reward_not_met");
});

// --- TC_DEC_04 ---
test("evaluateDecision blocks when API failure streak hits circuit breaker", () => {
  const result = evaluateDecision({
    apr: 1.5,
    tvlUsd: 50000,
    feeRate: 0.003,
    elapsedSec: 24 * 3600,
    gasCostUsd: 5,
    efficiencyMultiplier: 1.5,
    minNetRewardUsd: 1,
    maxGasUsd: 30,
    cooldownSec: 300,
    secondsSinceLastExecution: 9999,
    apiFailureStreak: 3,
    maxFailureStreak: 3,
  });
  assert.equal(result.shouldExecute, false);
  assert.equal(result.reason, "circuit_breaker_api_failures");
});

test("evaluateDecision blocks when cooldown period has not elapsed", () => {
  const result = evaluateDecision({
    apr: 1.5,
    tvlUsd: 50000,
    feeRate: 0.003,
    elapsedSec: 24 * 3600,
    gasCostUsd: 5,
    efficiencyMultiplier: 1.5,
    minNetRewardUsd: 1,
    maxGasUsd: 30,
    cooldownSec: 600,
    secondsSinceLastExecution: 100,
    apiFailureStreak: 0,
    maxFailureStreak: 3,
  });
  assert.equal(result.shouldExecute, false);
  assert.equal(result.reason, "cooldown_active");
});

test("evaluateDecision blocks when reward does not exceed gas threshold", () => {
  const result = evaluateDecision({
    apr: 0.05,
    tvlUsd: 1000,
    feeRate: 0.003,
    elapsedSec: 3600,
    gasCostUsd: 10,
    efficiencyMultiplier: 5,
    minNetRewardUsd: 0.001,
    maxGasUsd: 30,
    cooldownSec: 300,
    secondsSinceLastExecution: 9999,
    apiFailureStreak: 0,
    maxFailureStreak: 3,
  });
  assert.equal(result.shouldExecute, false);
  assert.equal(result.reason, "profitability_threshold_not_met");
});

test("evaluateDecision returns netRewardUsd and thresholdUsd in result", () => {
  const result = evaluateDecision({
    apr: 0.22,
    tvlUsd: 10000,
    feeRate: 0.003,
    elapsedSec: 3600,
    gasCostUsd: 5,
    efficiencyMultiplier: 1.5,
    minNetRewardUsd: 1,
    maxGasUsd: 30,
    cooldownSec: 300,
    secondsSinceLastExecution: 9999,
    apiFailureStreak: 0,
    maxFailureStreak: 3,
  });
  assert.ok(typeof result.netRewardUsd === "number");
  assert.ok(typeof result.thresholdUsd === "number");
  assert.ok(result.thresholdUsd === 5 * 1.5);
});

// --- calculateAdaptiveIntervalMs ---
test("calculateAdaptiveIntervalMs returns 2 min for very high APR", () => {
  assert.equal(calculateAdaptiveIntervalMs(0.6, 5), 2 * 60 * 1000);
});

test("calculateAdaptiveIntervalMs returns 4 min for moderate APR", () => {
  assert.equal(calculateAdaptiveIntervalMs(0.3, 5), 4 * 60 * 1000);
});

test("calculateAdaptiveIntervalMs returns 12 min when gas is high and APR is low", () => {
  assert.equal(calculateAdaptiveIntervalMs(0.1, 35), 12 * 60 * 1000);
});

test("calculateAdaptiveIntervalMs returns 8 min as default fallback", () => {
  assert.equal(calculateAdaptiveIntervalMs(0.1, 10), 8 * 60 * 1000);
});
