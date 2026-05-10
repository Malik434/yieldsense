/**
 * validateMainnetDeployment.cjs
 *
 * Post-deployment validation script.
 * Run AFTER the Safe has called acceptOwnership() on both contracts.
 * All checks must pass (exit 0) before proceeding to smoke test or raising the cap.
 *
 * Usage:
 *   npx hardhat run scripts/validateMainnetDeployment.cjs --network baseMainnet
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const hre  = require("hardhat");

const MANIFEST_PATH = path.join(__dirname, "..", "deployments", "base-mainnet.json");

// ── Expected Base Mainnet Constants ──────────────────────────────────────────
const USDC_ADDRESS    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO_ADDRESS    = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const ROUTER_ADDRESS  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const FACTORY_ADDRESS = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const POOL_ADDRESS    = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const GAUGE_ADDRESS   = "0x4F09bAb2f0E15e2A078A227FE1537665F55b8360";

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  if (e === a) ok(label, actual);
  else fail(label, expected, actual);
}

// ── Minimal ABIs ──────────────────────────────────────────────────────────────
const AUTOCOMPOUNDER_ABI = [
  "function owner() external view returns (address)",
  "function pendingOwner() external view returns (address)",
  "function keeper() external view returns (address)",
  "function pool() external view returns (address)",
  "function gauge() external view returns (address)",
  "function asset() external view returns (address)",
  "function rewardToken() external view returns (address)",
  "function router() external view returns (address)",
  "function factory() external view returns (address)",
  "function slippageBps() external view returns (uint256)",
];

const KEEPER_ABI = [
  "function owner() external view returns (address)",
  "function pendingOwner() external view returns (address)",
  "function autocompounder() external view returns (address)",
  "function asset() external view returns (address)",
  "function paused() external view returns (bool)",
  "function maxTotalAssets() external view returns (uint256)",
  "function allowedRouteToken(address) external view returns (bool)",
  "function allowedRouteFactory(address) external view returns (bool)",
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  YieldSense — Post-Deployment Mainnet State Validation");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  Network: ${network.name} (chainId: ${chainId})\n`);

  if (chainId !== 8453) {
    console.error(`\n🚨 ABORT: Must run on Base Mainnet (chainId 8453). Got: ${chainId}\n`);
    process.exitCode = 1;
    return;
  }

  // ── 1. Load manifest ───────────────────────────────────────────────────────
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`\n🚨 ABORT: Manifest not found at ${MANIFEST_PATH}`);
    console.error("         Run deployMainnet.cjs first.\n");
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const expectedOwner          = manifest.ownerExpected;
  const keeperAddr             = manifest.yieldSenseKeeper;
  const autocompounderAddr     = manifest.aerodromeAutocompounder;

  if (!expectedOwner || !keeperAddr || !autocompounderAddr) {
    console.error("\n🚨 ABORT: Manifest is missing ownerExpected, yieldSenseKeeper, or aerodromeAutocompounder.\n");
    process.exitCode = 1;
    return;
  }

  console.log(`  Manifest:        ${MANIFEST_PATH}`);
  console.log(`  Expected owner:  ${expectedOwner}`);
  console.log(`  Keeper:          ${keeperAddr}`);
  console.log(`  Autocompounder:  ${autocompounderAddr}\n`);

  const autocompounder = await hre.ethers.getContractAt(AUTOCOMPOUNDER_ABI, autocompounderAddr);
  const keeper         = await hre.ethers.getContractAt(KEEPER_ABI, keeperAddr);

  // ── 2. Ownership ───────────────────────────────────────────────────────────
  console.log("── Ownership ──");
  const autoOwner        = await autocompounder.owner();
  const autoPending      = await autocompounder.pendingOwner();
  const keeperOwner      = await keeper.owner();
  const keeperPending    = await keeper.pendingOwner();

  check("autocompounder.owner() == Safe", expectedOwner, autoOwner);
  check("keeperOwner.owner() == Safe",    expectedOwner, keeperOwner);

  if (autoPending !== hre.ethers.ZeroAddress) {
    fail("autocompounder.pendingOwner() should be zero (accepted)", hre.ethers.ZeroAddress, autoPending);
  } else {
    ok("autocompounder ownership fully accepted", "no pending owner");
  }

  if (keeperPending !== hre.ethers.ZeroAddress) {
    fail("keeper.pendingOwner() should be zero (accepted)", hre.ethers.ZeroAddress, keeperPending);
  } else {
    ok("keeper ownership fully accepted", "no pending owner");
  }

  // ── 3. Contract Wiring ─────────────────────────────────────────────────────
  console.log("\n── Contract Wiring ──");
  const autoKeeperAddr   = await autocompounder.keeper();
  const keeperAutoAddr   = await keeper.autocompounder();

  check("autocompounder.keeper() == YieldSenseKeeper", keeperAddr, autoKeeperAddr);
  check("keeper.autocompounder() == Autocompounder",    autocompounderAddr, keeperAutoAddr);

  // ── 4. Protocol Addresses ──────────────────────────────────────────────────
  console.log("\n── Protocol Addresses ──");
  check("autocompounder.pool()",        POOL_ADDRESS,    await autocompounder.pool());
  check("autocompounder.gauge()",       GAUGE_ADDRESS,   await autocompounder.gauge());
  check("autocompounder.asset()",       USDC_ADDRESS,    await autocompounder.asset());
  check("autocompounder.rewardToken()", AERO_ADDRESS,    await autocompounder.rewardToken());
  check("autocompounder.router()",      ROUTER_ADDRESS,  await autocompounder.router());
  check("autocompounder.factory()",     FACTORY_ADDRESS, await autocompounder.factory());
  check("keeper.asset()",              USDC_ADDRESS,    await keeper.asset());

  // ── 5. Safety Parameters ───────────────────────────────────────────────────
  console.log("\n── Safety Parameters ──");
  const slippage = Number(await autocompounder.slippageBps());
  const maxAssets = await keeper.maxTotalAssets();
  const isPaused  = await keeper.paused();

  if (slippage > 0 && slippage <= 300) {
    ok("slippageBps within approved range (1–300 bps)", slippage);
  } else if (slippage === 0) {
    fail("slippageBps is 0 — zero-slippage tolerance requires exact price match", "1–300", slippage);
  } else {
    fail("slippageBps exceeds 300 bps (3%) production limit", "≤300", slippage);
  }

  console.log(`  ℹ️  maxTotalAssets: ${hre.ethers.formatUnits(maxAssets, 6)} USDC`);
  if (maxAssets === 0n) {
    fail("maxTotalAssets is 0 — deposits are DISABLED. Safe must call setMaxTotalAssets().", "> 0", "0");
  } else {
    ok("maxTotalAssets is set (deposits enabled)", `${hre.ethers.formatUnits(maxAssets, 6)} USDC`);
  }

  if (isPaused) {
    console.log("  ⚠️  Vault is paused — expected for pre-launch. Unpause when ready.");
  } else {
    ok("Vault is not paused", "active");
  }

  // ── 6. Route Allowlists ────────────────────────────────────────────────────
  console.log("\n── Route Allowlists ──");
  const usdcAllowed    = await keeper.allowedRouteToken(USDC_ADDRESS);
  const aeroAllowed    = await keeper.allowedRouteToken(AERO_ADDRESS);
  const factoryAllowed = await keeper.allowedRouteFactory(FACTORY_ADDRESS);

  if (usdcAllowed) ok("USDC allowlisted as route token", USDC_ADDRESS);
  else fail("USDC not in route allowlist", "true", "false");

  if (aeroAllowed) ok("AERO allowlisted as route token", AERO_ADDRESS);
  else fail("AERO not in route allowlist", "true", "false");

  if (factoryAllowed) ok("Aerodrome Factory allowlisted as route factory", FACTORY_ADDRESS);
  else fail("Aerodrome Factory not in route allowlist", "true", "false");

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.error("🚨 VALIDATION FAILED — DO NOT PROCEED TO SMOKE TEST OR RAISE CAP.\n");
    process.exitCode = 1;
  } else {
    console.log("✅ All checks passed. Safe to proceed to smoke test.\n");
    console.log("   Next step: Call setMaxTotalAssets(10e6) via Safe for 1 USDC smoke test.\n");
  }
}

main().catch((err) => {
  console.error("\n🚨 Script error:", err.message);
  process.exitCode = 1;
});
