/**
 * verifyBaseAddresses.cjs
 *
 * Pre-deployment verification script.
 * Queries live Base mainnet state to confirm every protocol address is real,
 * correct, and properly wired before deployMainnet.cjs is executed.
 *
 * Usage:
 *   npx hardhat run scripts/verifyBaseAddresses.cjs --network baseMainnet
 *
 * All checks must pass (exit 0) before proceeding to deployment.
 */

"use strict";

const hre = require("hardhat");

// ─── Base Mainnet Constants (do NOT use env var fallbacks here) ───────────────
const USDC_ADDRESS    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO_ADDRESS    = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const ROUTER_ADDRESS  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const FACTORY_ADDRESS = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const POOL_ADDRESS    = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const GAUGE_ADDRESS   = "0x4F09bAb2f0E15e2A078A227FE1537665F55b8360";

// ─── Minimal ABIs for verification calls ─────────────────────────────────────
const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

const POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function stable() external view returns (bool)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, bool stable) external view returns (address)",
];

const GAUGE_ABI = [
  "function rewardToken() external view returns (address)",
  "function stakingToken() external view returns (address)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function ok(label, value) {
  console.log(`  ✅  ${label}: ${value}`);
  passed++;
}

function fail(label, expected, actual) {
  console.error(`  ❌  ${label}`);
  console.error(`         expected: ${expected}`);
  console.error(`         actual  : ${actual}`);
  failed++;
}

function check(label, expected, actual) {
  const e = String(expected).toLowerCase();
  const a = String(actual).toLowerCase();
  if (e === a) {
    ok(label, actual);
  } else {
    fail(label, expected, actual);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("\n════════════════════════════════════════════════════");
  console.log("  YieldSense — Base Mainnet Address Verification");
  console.log("════════════════════════════════════════════════════");
  console.log(`  Network: ${network.name} (chainId: ${chainId})\n`);

  if (chainId !== 8453) {
    console.error(`\n🚨 ABORT: This script must run on Base Mainnet (chainId 8453).`);
    console.error(`          Got chainId ${chainId}. Use --network baseMainnet\n`);
    process.exitCode = 1;
    return;
  }

  // ── 1. USDC ────────────────────────────────────────────────────────────────
  console.log("── USDC ──");
  const usdc = await hre.ethers.getContractAt(ERC20_ABI, USDC_ADDRESS);
  check("USDC symbol",    "USDC", await usdc.symbol());
  check("USDC decimals",  "6",    String(await usdc.decimals()));

  // ── 2. AERO ────────────────────────────────────────────────────────────────
  console.log("\n── AERO ──");
  const aero = await hre.ethers.getContractAt(ERC20_ABI, AERO_ADDRESS);
  check("AERO symbol", "AERO", await aero.symbol());

  // ── 3. Pool ────────────────────────────────────────────────────────────────
  console.log("\n── Aerodrome Pool (vAMM-USDC/AERO) ──");
  const pool = await hre.ethers.getContractAt(POOL_ABI, POOL_ADDRESS);

  const token0 = (await pool.token0()).toLowerCase();
  const token1 = (await pool.token1()).toLowerCase();
  const stable  = await pool.stable();

  const poolHasUsdc = token0 === USDC_ADDRESS.toLowerCase() || token1 === USDC_ADDRESS.toLowerCase();
  const poolHasAero = token0 === AERO_ADDRESS.toLowerCase() || token1 === AERO_ADDRESS.toLowerCase();

  if (poolHasUsdc) ok("pool.token0/1 contains USDC", USDC_ADDRESS);
  else fail("pool.token0/1 contains USDC", USDC_ADDRESS, `${token0} / ${token1}`);

  if (poolHasAero) ok("pool.token0/1 contains AERO", AERO_ADDRESS);
  else fail("pool.token0/1 contains AERO", AERO_ADDRESS, `${token0} / ${token1}`);

  check("pool.stable() is false (volatile pool)", "false", String(stable));

  // ── 4. Factory ────────────────────────────────────────────────────────────
  console.log("\n── Aerodrome Factory ──");
  const factory = await hre.ethers.getContractAt(FACTORY_ABI, FACTORY_ADDRESS);
  const poolFromFactory = await factory.getPool(USDC_ADDRESS, AERO_ADDRESS, false);
  check(
    "factory.getPool(USDC, AERO, false) === pool",
    POOL_ADDRESS.toLowerCase(),
    poolFromFactory.toLowerCase()
  );

  // ── 5. Gauge ──────────────────────────────────────────────────────────────
  console.log("\n── Aerodrome Gauge ──");
  const gauge = await hre.ethers.getContractAt(GAUGE_ABI, GAUGE_ADDRESS);

  const gaugeRewardToken  = (await gauge.rewardToken()).toLowerCase();
  const gaugeStakingToken = (await gauge.stakingToken()).toLowerCase();

  check("gauge.rewardToken() === AERO",     AERO_ADDRESS.toLowerCase(), gaugeRewardToken);
  check("gauge.stakingToken() === pool LP", POOL_ADDRESS.toLowerCase(), gaugeStakingToken);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.error("🚨 ADDRESS VERIFICATION FAILED — DO NOT PROCEED TO DEPLOYMENT.\n");
    process.exitCode = 1;
  } else {
    console.log("✅ All addresses verified. Safe to proceed to deployMainnet.cjs\n");
  }
}

main().catch((err) => {
  console.error("\n🚨 Script error:", err.message);
  process.exitCode = 1;
});
