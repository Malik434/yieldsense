/**
 * deployMainnet.cjs
 *
 * YieldSense — Base Mainnet Production Deployment
 *
 * Deploys AerodromeAutocompounder and YieldSenseKeeper to Base Mainnet,
 * wires them together, transfers ownership to a Safe multisig,
 * and writes a deployment manifest.
 *
 * Pre-conditions (all must be met before running):
 *   1. scripts/verifyBaseAddresses.cjs must exit 0
 *   2. .env must contain DEPLOYER_PRIVATE_KEY (funded with Base ETH)
 *   3. .env must contain PROTOCOL_OWNER_ADDRESS (Gnosis Safe on Base)
 *   4. This script MUST be run with --network baseMainnet
 *
 * Usage:
 *   npx hardhat run scripts/deployMainnet.cjs --network baseMainnet
 *
 * After deployment:
 *   - Safe accepts ownership and confirms the Autocompounder keeper is correct
 *   - Safe calls lockKeeper() on AerodromeAutocompounder
 *   - Deploy Acurast job and call ownerAttestProcessor(processorAddress) via Safe
 *   - Run BaseScan verification with commands printed at the end
 */

"use strict";

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── Base Mainnet Protocol Constants ─────────────────────────────────────────
// These are HARDCODED. Do NOT override via env vars to prevent misconfiguration.
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Native USDC on Base
const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631"; // AERO on Base
const ROUTER_ADDRESS = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"; // Aerodrome Router V2
const FACTORY_ADDRESS = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da"; // Aerodrome Factory
const POOL_ADDRESS = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d"; // vAMM-USDC/AERO pool
const GAUGE_ADDRESS = "0x4F09bAb2f0E15e2A078A227FE1537665F55b8360"; // vAMM-USDC/AERO gauge

async function main() {
  // ── 0. Chain guard — abort immediately if not Base Mainnet ────────────────
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (chainId !== 8453) {
    console.error(`\n🚨 ABORT: This script only runs on Base Mainnet (chainId 8453).`);
    console.error(`          Detected chainId: ${chainId}`);
    console.error(`          Use: npx hardhat run scripts/deployMainnet.cjs --network baseMainnet\n`);
    process.exitCode = 1;
    return;
  }

  // ── 1. Load operator addresses from env ───────────────────────────────────
  const ownerAddress = process.env.PROTOCOL_OWNER_ADDRESS?.trim();

  if (!ownerAddress) {
    console.error("\n🚨 ABORT: PROTOCOL_OWNER_ADDRESS is not set. Set this to your Gnosis Safe address.\n");
    process.exitCode = 1;
    return;
  }

  const [deployer] = await hre.ethers.getSigners();
  const deployerBalance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║   YieldSense — Base Mainnet Production Deployment      ║");
  console.log("╚════════════════════════════════════════════════════════╝");
  console.log(`  Network   : Base Mainnet (chainId: ${chainId})`);
  console.log(`  Deployer  : ${deployer.address}`);
  console.log(`  Balance   : ${hre.ethers.formatEther(deployerBalance)} ETH`);
  console.log(`  Owner     : ${ownerAddress} (Safe/Multisig)`);
  console.log();

  if (deployerBalance < hre.ethers.parseEther("0.002")) {
    console.error("🚨 ABORT: Deployer has less than 0.002 ETH on Base. Fund the deployer wallet first.");
    console.error("   Note: 0.002 ETH is very tight for contract deployments. 0.01 ETH is recommended.\n");
    process.exitCode = 1;
    return;
  }

  // ── 2. Deploy AerodromeAutocompounder ─────────────────────────────────────
  console.log("Deploying AerodromeAutocompounder...");
  const Autocompounder = await hre.ethers.getContractFactory("AerodromeAutocompounder");
  const autocompounder = await Autocompounder.deploy(
    POOL_ADDRESS,
    GAUGE_ADDRESS,
    USDC_ADDRESS,
    AERO_ADDRESS,
    ROUTER_ADDRESS,
    FACTORY_ADDRESS,
    deployer.address, // temporary keeper — updated to YieldSenseKeeper below
    { gasLimit: 4_000_000 }
  );
  await autocompounder.waitForDeployment();
  const autocompounderAddress = await autocompounder.getAddress();
  console.log(`✅ AerodromeAutocompounder → ${autocompounderAddress}`);

  // ── 3. Deploy YieldSenseKeeper ────────────────────────────────────────────
  console.log("\nDeploying YieldSenseKeeper...");
  const Keeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await Keeper.deploy(
    USDC_ADDRESS,
    AERO_ADDRESS,           // yieldSource (passed to constructor as counterparty/yieldSource)
    deployer.address,       // counterparty — updated to multisig by ownership transfer
    autocompounderAddress,
    { gasLimit: 5_000_000 }
  );
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  console.log(`✅ YieldSenseKeeper         → ${keeperAddress}`);

  // ── 4. Wire: set YieldSenseKeeper as the Autocompounder's keeper ──────────
  console.log("\nWiring autocompounder.setKeeper(keeperAddress)...");
  await (await autocompounder.setKeeper(keeperAddress, { gasLimit: 100_000 })).wait();
  console.log("✅ Keeper authorized on Autocompounder");

  // ── 5. Set initial deposit cap to 20 USDC ─────────────────────────────────
  // Initial MVP cap: enable deposits, but keep exposure limited for smoke testing.
  console.log("\nSetting initial deposit cap to 20 USDC...");
  const initialCap = hre.ethers.parseUnits("20", 6);

  await (await keeper.setMaxTotalAssets(initialCap, { gasLimit: 100_000 })).wait();

  const cap = await keeper.maxTotalAssets();
  if (cap !== initialCap) {
    throw new Error(`Cap mismatch after setMaxTotalAssets: ${cap.toString()}`);
  }

  console.log("✅ Deposit cap set to 20 USDC");

  // ── 6. Mandatory: transfer ownership to multisig ──────────────────────────
  console.log(`\nTransferring ownership to Safe: ${ownerAddress}...`);
  await (await autocompounder.transferOwnership(ownerAddress, { gasLimit: 100_000 })).wait();
  await (await keeper.transferOwnership(ownerAddress, { gasLimit: 100_000 })).wait();

  // Note: Ownable2Step requires the new owner to call acceptOwnership().
  // The Safe multisig must execute acceptOwnership() on both contracts.
  console.log("✅ Ownership transfer initiated (Ownable2Step).");
  console.log("   ⚠️  The Safe multisig must call acceptOwnership() on BOTH contracts.");

  // ── 7. Fetch deployment block ──────────────────────────────────────────────
  const deploymentBlock = await hre.ethers.provider.getBlockNumber();
  let gitCommit = "unknown";
  try {
    gitCommit = execSync("git rev-parse --short HEAD", { stdio: ["pipe", "pipe", "ignore"] })
      .toString().trim();
  } catch (_) { /* not a git repo or git not available */ }

  // ── 8. Write deployment manifest ──────────────────────────────────────────
  const manifest = {
    network: "baseMainnet",
    chainId: 8453,
    deployer: deployer.address,
    ownerExpected: ownerAddress,
    ownerAccepted: false, // Safe must call acceptOwnership() — update to true after verification
    yieldSenseKeeper: keeperAddress,
    aerodromeAutocompounder: autocompounderAddress,
    initialMaxTotalAssets: initialCap.toString(),
    usdc: USDC_ADDRESS,
    aero: AERO_ADDRESS,
    router: ROUTER_ADDRESS,
    factory: FACTORY_ADDRESS,
    pool: POOL_ADDRESS,
    gauge: GAUGE_ADDRESS,
    deploymentBlock,
    gitCommit,
    timestamp: new Date().toISOString()
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const manifestPath = path.join(deploymentsDir, "base-mainnet.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n✅ Manifest written → ${manifestPath}`);

  // ── 9. Summary ────────────────────────────────────────────────────────────
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║   DEPLOYMENT COMPLETE — COPY TO FRONTEND .env              ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log(`NEXT_PUBLIC_KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`NEXT_PUBLIC_AUTOCOMPOUNDER_ADDRESS=${autocompounderAddress}`);
  console.log(`NEXT_PUBLIC_CHAIN_ID=8453`);
  console.log(`NEXT_PUBLIC_ASSET_ADDRESS=${USDC_ADDRESS}`);

  console.log("\n── BaseScan Verification Commands ──────────────────────────────");
  console.log(`npx hardhat verify --network baseMainnet ${autocompounderAddress} \\`);
  console.log(`  ${POOL_ADDRESS} ${GAUGE_ADDRESS} ${USDC_ADDRESS} \\`);
  console.log(`  ${AERO_ADDRESS} ${ROUTER_ADDRESS} ${FACTORY_ADDRESS} ${deployer.address}`);
  console.log();
  console.log(`npx hardhat verify --network baseMainnet ${keeperAddress} \\`);
  console.log(`  ${USDC_ADDRESS} ${AERO_ADDRESS} ${deployer.address} ${autocompounderAddress}`);

  console.log("\n── Required Post-Deployment Actions (via Safe Multisig) ─────────");
  console.log(`1. Call acceptOwnership() on AerodromeAutocompounder (${autocompounderAddress})`);
  console.log(`2. Call acceptOwnership() on YieldSenseKeeper (${keeperAddress})`);
  console.log(`3. Confirm autocompounder.keeper() == ${keeperAddress}, then call autocompounder.lockKeeper()`);
  console.log(`4. Deploy Acurast job and call keeper.ownerAttestProcessor(processorEVMAddress)`);
  console.log(`5. Confirm keeper.maxTotalAssets() == 20000000. Do not increase cap until smoke test passes.`);
  console.log(`6. Run the 1 USDC smoke test\n`);
}

main().catch((err) => {
  console.error("\n🚨 Deployment failed:", err.message);
  process.exitCode = 1;
});
