/**
 * Live yield test script for Aerodrome & Moonwell on Base.
 * Run: npx tsx src/yieldTest.ts
 */
import { ethers } from "ethers";
import {
  getAerodromeYields,
  getMoonwellYields,
  getProtocolYieldSummary,
} from "./yieldEngine/ingestion/defiLlamaYields.js";
import {
  fetchAllMoonwellMarkets,
  MOONWELL_MARKETS_BASE,
} from "./yieldEngine/ingestion/moonwellMarkets.js";

const BASE_RPC = "https://base.llamarpc.com";

async function main() {
  console.log("=".repeat(70));
  console.log("  YieldSense — Live Yield Data Test (Base Mainnet)");
  console.log("=".repeat(70));
  console.log();

  // ──────────────────────────────────────────────────
  // 1. DefiLlama Yields API — Aerodrome
  // ──────────────────────────────────────────────────
  console.log("📊 Fetching Aerodrome pools from DefiLlama Yields API...\n");
  try {
    const aeroPools = await getAerodromeYields(50_000, 10);
    console.log(`Found ${aeroPools.length} Aerodrome pools with TVL > $50k:\n`);
    console.log(
      "  Pool                           | TVL ($)        | APY (%)   | Base APY | Reward APY"
    );
    console.log("  " + "-".repeat(90));
    for (const p of aeroPools) {
      const sym = (p.symbol ?? "???").padEnd(30);
      const tvl = `$${(p.tvlUsd / 1e6).toFixed(2)}M`.padEnd(14);
      const apy = (p.apy ?? 0).toFixed(2).padStart(8);
      const base = (p.apyBase ?? 0).toFixed(2).padStart(8);
      const reward = (p.apyReward ?? 0).toFixed(2).padStart(10);
      console.log(`  ${sym} | ${tvl} | ${apy}%  | ${base}% | ${reward}%`);
    }
  } catch (e: any) {
    console.error("❌ DefiLlama Aerodrome fetch failed:", e.message);
  }

  console.log();

  // ──────────────────────────────────────────────────
  // 2. DefiLlama Yields API — Moonwell
  // ──────────────────────────────────────────────────
  console.log("🌙 Fetching Moonwell markets from DefiLlama Yields API...\n");
  try {
    const moonPools = await getMoonwellYields(50_000, 10);
    console.log(`Found ${moonPools.length} Moonwell markets with TVL > $50k:\n`);
    console.log(
      "  Market                         | TVL ($)        | APY (%)   | Base APY | Reward APY"
    );
    console.log("  " + "-".repeat(90));
    for (const p of moonPools) {
      const sym = (p.symbol ?? "???").padEnd(30);
      const tvl = `$${(p.tvlUsd / 1e6).toFixed(2)}M`.padEnd(14);
      const apy = (p.apy ?? 0).toFixed(2).padStart(8);
      const base = (p.apyBase ?? 0).toFixed(2).padStart(8);
      const reward = (p.apyReward ?? 0).toFixed(2).padStart(10);
      console.log(`  ${sym} | ${tvl} | ${apy}%  | ${base}% | ${reward}%`);
    }
  } catch (e: any) {
    console.error("❌ DefiLlama Moonwell fetch failed:", e.message);
  }

  console.log();

  // ──────────────────────────────────────────────────
  // 3. On-Chain Moonwell Markets (Direct RPC)
  // ──────────────────────────────────────────────────
  console.log("🔗 Fetching Moonwell markets directly from Base RPC...\n");
  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const markets = await fetchAllMoonwellMarkets(provider);
    console.log(`Fetched ${markets.length} / ${Object.keys(MOONWELL_MARKETS_BASE).length} markets on-chain:\n`);
    console.log(
      "  Market     | Supply APY (%) | Borrow APY (%) | Utilization (%)"
    );
    console.log("  " + "-".repeat(65));
    for (const m of markets) {
      const sym = m.label.padEnd(10);
      const supplyApy = m.supplyApyPercent.toFixed(2).padStart(13);
      const borrowApy = m.borrowApyPercent.toFixed(2).padStart(13);
      const util = m.utilizationPercent.toFixed(1).padStart(14);
      console.log(`  ${sym} | ${supplyApy}%  | ${borrowApy}%  | ${util}%`);
    }
  } catch (e: any) {
    console.error("❌ On-chain Moonwell fetch failed:", e.message);
  }

  console.log();

  // ──────────────────────────────────────────────────
  // 4. Combined Summary
  // ──────────────────────────────────────────────────
  console.log("📈 Protocol Yield Summary...\n");
  try {
    const summary = await getProtocolYieldSummary();
    console.log(`  Aerodrome: ${summary.aerodrome.poolCount} pools monitored`);
    if (summary.aerodrome.topPools.length > 0) {
      const top = summary.aerodrome.topPools[0];
      console.log(`    Top pool: ${top.symbol} — APY: ${top.apy.toFixed(2)}%, TVL: $${(top.tvlUsd / 1e6).toFixed(2)}M`);
    }
    console.log(`  Moonwell:  ${summary.moonwell.marketCount} markets monitored`);
    if (summary.moonwell.topMarkets.length > 0) {
      const top = summary.moonwell.topMarkets[0];
      console.log(`    Top market: ${top.symbol} — APY: ${top.apy.toFixed(2)}%, TVL: $${(top.tvlUsd / 1e6).toFixed(2)}M`);
    }
    console.log(`  Fetched at: ${new Date(summary.fetchedAt * 1000).toISOString()}`);
  } catch (e: any) {
    console.error("❌ Summary fetch failed:", e.message);
  }

  console.log();
  console.log("✅ Yield test complete!");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exitCode = 1;
});
