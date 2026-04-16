import test from "node:test";
import assert from "node:assert/strict";
import { annualizedFeeApr, feeAprFromIndex } from "./compute/feeApr.js";
import { totalAprToApy } from "./compute/apy.js";
import { feeUsdFromSwapInputs } from "./ingestion/prices.js";
import { compositeConfidence, liquiditySensitivityPenalty } from "./robustness/confidence.js";
import { smoothedRewardApr } from "./compute/rewardApr.js";
import { estimateForwardApr } from "./compute/forwardAerodrome.js";
import { ewmaAlphaFromHalfLife, updateEwma, trimMean, coefficientOfVariation } from "./robustness/smoothing.js";
import type { RewardGaugeSnapshot, FeeIndexResult } from "./types.js";

test("annualizedFeeApr scales window to year", () => {
  const apr = annualizedFeeApr(700, 10_000, 7 * 24 * 3600);
  assert.ok(apr > 1 && apr < 5);
});

test("totalAprToApy daily compound", () => {
  const apy = totalAprToApy(0.1, 365);
  assert.ok(apy > 0.1 && apy < 0.11);
});

test("feeUsdFromSwapInputs applies fee bps", () => {
  const prices = { decimals0: 18, decimals1: 6, price0Usd: 3500, price1Usd: 1 };
  const usd = feeUsdFromSwapInputs(
    BigInt(1e18),
    BigInt(0),
    30,
    prices
  );
  assert.ok(usd > 0 && usd < 20);
});

test("compositeConfidence penalizes low coverage", () => {
  const high = compositeConfidence({
    coverageRatio: 0.95,
    feeVariancePenalty: 1,
    oracleScore: 0.9,
    gaugeScore: 1,
    consistencyScore: 1,
  });
  const low = compositeConfidence({
    coverageRatio: 0.3,
    feeVariancePenalty: 1,
    oracleScore: 0.9,
    gaugeScore: 1,
    consistencyScore: 1,
  });
  assert.ok(high > low);
});

test("liquiditySensitivityPenalty shrinks with large delta", () => {
  assert.equal(liquiditySensitivityPenalty(1_000_000, undefined), 1);
  assert.ok(liquiditySensitivityPenalty(1_000_000, 500_000) < 1);
});

test("smoothedRewardApr EWMA updates", () => {
  const snap: RewardGaugeSnapshot = {
    rewardRate: 1n,
    periodFinish: BigInt(Math.floor(Date.now() / 1000) + 86400),
    totalSupply: BigInt(1e18),
    rewardToken: "0x0",
    rewardUsdPerSec: 1,
    stakedUsd: 10_000,
    rewardAprInstant: 0.5,
  };
  const first = smoothedRewardApr(snap, null, 3600, 60);
  assert.equal(first.rewardApr, 0.5);
  const second = smoothedRewardApr(snap, first.ewmNext, 3600, 60);
  assert.ok(second.rewardApr > 0.45 && second.rewardApr <= 0.55);
});

test("estimateForwardApr includes notes", () => {
  const snap: RewardGaugeSnapshot = {
    rewardRate: 1n,
    periodFinish: BigInt(Math.floor(Date.now() / 1000) + 86400 * 14),
    totalSupply: BigInt(1e18),
    rewardToken: "0x0",
    rewardUsdPerSec: 1,
    stakedUsd: 10_000,
    rewardAprInstant: 0.2,
  };
  const f = estimateForwardApr({ snapshot: snap, feeApr: 0.05, epochHorizonSec: 7 * 86400 });
  assert.ok(f.notes.length > 0);
  assert.ok(f.totalApr >= f.rewardApr);
});

test("estimateForwardApr adds warning note when periodFinish is before horizon", () => {
  const now = Math.floor(Date.now() / 1000);
  const snap: RewardGaugeSnapshot = {
    rewardRate: 1n,
    periodFinish: BigInt(now + 3600),
    totalSupply: BigInt(1e18),
    rewardToken: "0x0",
    rewardUsdPerSec: 1,
    stakedUsd: 10_000,
    rewardAprInstant: 0.3,
  };
  const f = estimateForwardApr({ snapshot: snap, feeApr: 0.05, epochHorizonSec: 7 * 86400 });
  assert.ok(f.notes.some((n) => n.includes("periodFinish")));
});

// --- ewmaAlphaFromHalfLife ---
test("ewmaAlphaFromHalfLife returns 1 for zero half-life", () => {
  assert.equal(ewmaAlphaFromHalfLife(0, 3600), 1);
});

test("ewmaAlphaFromHalfLife returns value in (0,1) for valid inputs", () => {
  const alpha = ewmaAlphaFromHalfLife(3600, 3600);
  assert.ok(alpha > 0 && alpha < 1);
});

test("ewmaAlphaFromHalfLife is larger for longer elapsed vs same half-life", () => {
  const slow = ewmaAlphaFromHalfLife(3600, 600);
  const fast = ewmaAlphaFromHalfLife(3600, 7200);
  assert.ok(fast > slow);
});

// --- updateEwma ---
test("updateEwma with alpha=1 returns sample exactly", () => {
  assert.equal(updateEwma(0.5, 0.9, 1), 0.9);
});

test("updateEwma with alpha=0 returns previous exactly", () => {
  assert.equal(updateEwma(0.5, 0.9, 0), 0.5);
});

test("updateEwma blends between previous and sample", () => {
  const result = updateEwma(0.4, 0.8, 0.5);
  assert.ok(Math.abs(result - 0.6) < 1e-10);
});

// --- trimMean ---
test("trimMean returns 0 for empty array", () => {
  assert.equal(trimMean([], 0.1, 0.1), 0);
});

test("trimMean removes high outliers", () => {
  const values = [1, 2, 3, 4, 100];
  const mean = trimMean(values, 0, 0.2);
  assert.ok(mean < 10, "Outlier 100 should be trimmed away");
});

test("trimMean with no trimming equals regular mean", () => {
  const values = [2, 4, 6];
  const result = trimMean(values, 0, 0);
  const expected = (2 + 4 + 6) / 3;
  assert.ok(Math.abs(result - expected) < 1e-10);
});

// --- coefficientOfVariation ---
test("coefficientOfVariation returns 0 for single-element array", () => {
  assert.equal(coefficientOfVariation([5]), 0);
});

test("coefficientOfVariation returns 0 for uniform values", () => {
  assert.equal(coefficientOfVariation([3, 3, 3, 3]), 0);
});

test("coefficientOfVariation is positive for dispersed values", () => {
  const cv = coefficientOfVariation([1, 5, 10, 50]);
  assert.ok(cv > 0);
});

// --- feeAprFromIndex ---
test("feeAprFromIndex uses regular TVL when harmonic is disabled", () => {
  const index: FeeIndexResult = {
    feeUsd: 700,
    swapCount: 100,
    fromBlock: 0,
    toBlock: 100,
    coverageRatio: 1,
    windowSecActual: 7 * 24 * 3600,
    failedChunks: 0,
    totalChunks: 10,
  };
  const apr = feeAprFromIndex(index, 10_000, false);
  assert.ok(apr > 1 && apr < 5);
});

test("feeAprFromIndex uses harmonicTvl when enabled and provided", () => {
  const index: FeeIndexResult = {
    feeUsd: 700,
    swapCount: 100,
    fromBlock: 0,
    toBlock: 100,
    coverageRatio: 1,
    windowSecActual: 7 * 24 * 3600,
    failedChunks: 0,
    totalChunks: 10,
  };
  const aprRegular = feeAprFromIndex(index, 10_000, false);
  const aprHarmonic = feeAprFromIndex(index, 10_000, true, 5_000);
  assert.ok(aprHarmonic > aprRegular, "Lower harmonic TVL should yield higher APR");
});

test("feeAprFromIndex returns 0 for zero window", () => {
  const index: FeeIndexResult = {
    feeUsd: 700,
    swapCount: 10,
    fromBlock: 0,
    toBlock: 1,
    coverageRatio: 1,
    windowSecActual: 0,
    failedChunks: 0,
    totalChunks: 1,
  };
  assert.equal(feeAprFromIndex(index, 10_000, false), 0);
});
