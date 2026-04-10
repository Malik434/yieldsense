import { getRealtimeAprConsensus } from "./realtimeApr.js";
import { evaluateDecision } from "./decisionEngine.js";

const poolsFromArgs = process.argv.slice(2).filter(Boolean);
const pools =
  poolsFromArgs.length > 0
    ? poolsFromArgs
    : [
        "0xd0b53D9277642d899DF5C87A3966A349A798F224",
        "0x0000000000000000000000000000000000000000",
        "0x1111111111111111111111111111111111111111",
      ];

function printDivider(): void {
  console.log("------------------------------------------------------------");
}

async function run(): Promise<void> {
  console.log("YieldSense multi-pool APR + harvest decision smoke");
  printDivider();

  for (const pool of pools) {
    const consensus = await getRealtimeAprConsensus(pool, 1200, 0.55);
    const apr = consensus.apr ?? 0;
    const decision = evaluateDecision({
      apr,
      tvlUsd: 10000,
      feeRate: 0.003,
      elapsedSec: 3600,
      gasCostUsd: 3.5,
      efficiencyMultiplier: 1.5,
      minNetRewardUsd: 1,
      maxGasUsd: 30,
      cooldownSec: 300,
      secondsSinceLastExecution: 999_999,
      apiFailureStreak: consensus.usable ? 0 : 1,
      maxFailureStreak: 3,
    });

    console.log(`pool=${pool}`);
    console.log(
      JSON.stringify(
        {
          apr,
          confidence: consensus.confidence,
          usable: consensus.usable,
          sources: consensus.observations.map((o) => ({
            source: o.source,
            apr: o.apr,
            confidence: o.confidence,
            error: o.error ?? null,
          })),
          decision: {
            shouldExecute: decision.shouldExecute,
            reason: decision.reason,
            netRewardUsd: Number(decision.netRewardUsd.toFixed(6)),
            thresholdUsd: Number(decision.thresholdUsd.toFixed(6)),
            recommendedNextCheckMs: decision.recommendedNextCheckMs,
          },
        },
        null,
        2
      )
    );
    printDivider();
  }
}

run().catch((error: any) => {
  console.error("pool smoke failed:", error?.message ?? String(error));
  process.exitCode = 1;
});
