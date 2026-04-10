import test from "node:test";
import assert from "node:assert/strict";
import { annualizedFeeApr } from "./compute/feeApr.js";
import { totalAprToApy } from "./compute/apy.js";
import { feeUsdFromSwapInputs } from "./ingestion/prices.js";
import { compositeConfidence, liquiditySensitivityPenalty } from "./robustness/confidence.js";
import { smoothedRewardApr } from "./compute/rewardApr.js";
import { estimateForwardApr } from "./compute/forwardAerodrome.js";
import type { RewardGaugeSnapshot } from "./types.js";

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
