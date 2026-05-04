export interface DecisionInputs {
  apr: number;
  tvlUsd: number;
  feeRate: number;
  elapsedSec: number;
  gasCostUsd: number;
  efficiencyMultiplier: number;
  minNetRewardUsd: number;
  maxGasUsd: number;
  cooldownSec: number;
  secondsSinceLastExecution: number;
  apiFailureStreak: number;
  maxFailureStreak: number;
}

export interface DecisionResult {
  shouldExecute: boolean;
  reason: string;
  grossRewardUsd: number;
  netRewardUsd: number;
  thresholdUsd: number;
  recommendedNextCheckMs: number;
}

const YEAR_SECONDS = 31_536_000;

export function calculateAdaptiveIntervalMs(apr: number, gasCostUsd: number): number {
  if (apr > 0.5) return 2 * 60 * 1000;
  if (apr > 0.2) return 4 * 60 * 1000;
  if (gasCostUsd > 30) return 12 * 60 * 1000;
  return 8 * 60 * 1000;
}

export function evaluateDecision(input: DecisionInputs): DecisionResult {
  const grossReward = (input.tvlUsd * input.apr * input.elapsedSec) / YEAR_SECONDS;
  const netRewardUsd = grossReward * (1 - input.feeRate);
  const thresholdUsd = input.gasCostUsd * input.efficiencyMultiplier;
  const recommendedNextCheckMs = calculateAdaptiveIntervalMs(input.apr, input.gasCostUsd);

  if (input.apiFailureStreak >= input.maxFailureStreak) {
    return {
      shouldExecute: false,
      reason: "circuit_breaker_api_failures",
      grossRewardUsd: grossReward,
      netRewardUsd,
      thresholdUsd,
      recommendedNextCheckMs,
    };
  }

  if (input.secondsSinceLastExecution < input.cooldownSec) {
    return {
      shouldExecute: false,
      reason: "cooldown_active",
      grossRewardUsd: grossReward,
      netRewardUsd,
      thresholdUsd,
      recommendedNextCheckMs,
    };
  }

  if (input.gasCostUsd > input.maxGasUsd) {
    return {
      shouldExecute: false,
      reason: "gas_too_high",
      grossRewardUsd: grossReward,
      netRewardUsd,
      thresholdUsd,
      recommendedNextCheckMs,
    };
  }

  if (netRewardUsd < input.minNetRewardUsd) {
    return {
      shouldExecute: false,
      reason: "min_reward_not_met",
      grossRewardUsd: grossReward,
      netRewardUsd,
      thresholdUsd,
      recommendedNextCheckMs,
    };
  }

  if (netRewardUsd <= thresholdUsd) {
    return {
      shouldExecute: false,
      reason: "profitability_threshold_not_met",
      grossRewardUsd: grossReward,
      netRewardUsd,
      thresholdUsd,
      recommendedNextCheckMs,
    };
  }

  return {
    shouldExecute: true,
    reason: "profitable",
    grossRewardUsd: grossReward,
    netRewardUsd,
    thresholdUsd,
    recommendedNextCheckMs,
  };
}
