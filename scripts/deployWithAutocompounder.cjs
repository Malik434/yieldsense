/**
 * deployWithAutocompounder.cjs
 *
 * Deploys the full YieldSense stack:
 *   1. MockUSDC (testnet only — skip on mainnet)
 *   2. AerodromeAutocompounder  → holds LP in Aerodrome gauge, harvests AERO
 *   3. YieldSenseKeeper         → vault + TEE trade execution
 *   4. Wires them: setKeeper + setAutocompounder + approvals + attest deployer
 *
 * For MAINNET: set the *_ADDRESS env vars below to real deployed addresses
 * and the script skips the mock deployments automatically.
 *
 * Usage:
 *   npx hardhat run scripts/deployWithAutocompounder.cjs --network baseSepolia
 *   npx hardhat run scripts/deployWithAutocompounder.cjs --network base
 */

const hre = require("hardhat");

// ─── Protocol Addresses (Base Mainnet defaults) ───────────────────────────────
// Override via env vars to point to a different pool/gauge.
const POOL_ADDRESS    = process.env.POOL_ADDRESS    || ""; // Aerodrome LP pool
const GAUGE_ADDRESS   = process.env.GAUGE_ADDRESS   || ""; // Aerodrome gauge
const ROUTER_ADDRESS  = process.env.ROUTER_ADDRESS  || "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"; // Aerodrome Router V2 on Base
const ASSET_ADDRESS   = process.env.ASSET_ADDRESS   || ""; // USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const isTestnet = [84531n, 84532n, 31337n].includes(network.chainId);

  console.log("\n====================================================");
  console.log("  YieldSense Full Stack Deployer");
  console.log("====================================================");
  console.log("  Deployer :", deployer.address);
  console.log("  Network  :", network.name, `(chainId: ${network.chainId})`);
  console.log("  Mode     :", isTestnet ? "TESTNET (MockUSDC)" : "MAINNET (real tokens)");
  console.log("====================================================\n");

  // ─── 1. Asset Token ──────────────────────────────────────────────────────────
  let assetAddress = ASSET_ADDRESS;

  if (!assetAddress) {
    if (!isTestnet) throw new Error("ASSET_ADDRESS must be set for mainnet deployments");
    console.log("Deploying MockUSDC (6 decimals)...");
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const mock = await MockUSDC.deploy(6, { gasLimit: 3_000_000 });
    await mock.waitForDeployment();
    assetAddress = await mock.getAddress();
    console.log("✅ MockUSDC deployed  →", assetAddress);

    // Mint 100k USDC to deployer for testing
    await (await mock.mint(hre.ethers.parseUnits("100000", 6))).wait();
    console.log("   Minted 100,000 USDC to deployer");
  } else {
    console.log("✔  Using existing asset →", assetAddress);
  }

  // ─── 2. AerodromeAutocompounder ──────────────────────────────────────────────
  let autocompounderAddress;

  // On testnet: ALWAYS use the MockAutocompounder — mainnet Aerodrome addresses
  // (pool, gauge, router) do NOT exist on Base Sepolia, so the real contract
  // constructor would revert when it tries to interact with them.
  const useMock = isTestnet || !POOL_ADDRESS || !GAUGE_ADDRESS;

  if (useMock) {
    if (isTestnet && POOL_ADDRESS) {
      console.log("\n⚠  Testnet detected — ignoring mainnet POOL_ADDRESS/GAUGE_ADDRESS.");
      console.log("   Using MockAutocompounder so you can test the full flow locally.\n");
    } else {
      console.log("\n⚠  POOL_ADDRESS / GAUGE_ADDRESS not set — using MockAutocompounder.\n");
    }

    const MockAutocompounder = await hre.ethers.getContractFactory("MockAutocompounder");
    const mockComp = await MockAutocompounder.deploy(assetAddress, { gasLimit: 2_000_000 });
    await mockComp.waitForDeployment();
    autocompounderAddress = await mockComp.getAddress();
    console.log("✅ MockAutocompounder deployed →", autocompounderAddress);
  } else {
    // ── Mainnet: deploy the real AerodromeAutocompounder ───────────────────
    // REWARD_TOKEN_ADDRESS should be the AERO token: 0x940181a94A35A4569E4529A3CDfB74e38FD98631
    const rewardToken = process.env.REWARD_TOKEN_ADDRESS || "";
    if (!rewardToken) {
      throw new Error(
        "REWARD_TOKEN_ADDRESS must be set for mainnet deployment (e.g. AERO: 0x940181a94A35A4569E4529A3CDfB74e38FD98631)"
      );
    }

    console.log("Deploying AerodromeAutocompounder...");
    console.log("   pool         →", POOL_ADDRESS);
    console.log("   gauge        →", GAUGE_ADDRESS);
    console.log("   router       →", ROUTER_ADDRESS);
    console.log("   rewardToken  →", rewardToken);

    const Autocompounder = await hre.ethers.getContractFactory("AerodromeAutocompounder");
    const compounder = await Autocompounder.deploy(
      POOL_ADDRESS,
      GAUGE_ADDRESS,
      assetAddress,
      rewardToken,     // <-- explicit param, no constructor RPC call
      ROUTER_ADDRESS,
      deployer.address, // keeper — updated below once Keeper is deployed
      { gasLimit: 6_000_000 }
    );
    await compounder.waitForDeployment();
    autocompounderAddress = await compounder.getAddress();
    console.log("✅ AerodromeAutocompounder deployed →", autocompounderAddress);
  }

  // ─── 3. YieldSenseKeeper ─────────────────────────────────────────────────────
  console.log("\nDeploying YieldSenseKeeper...");
  const acurastSigner = deployer.address; // In production: Acurast TEE EVM address
  const yieldSource   = autocompounderAddress; // The compounder IS the yield source
  const counterparty  = deployer.address;      // Where losses go in grid trades

  const Keeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await Keeper.deploy(
    assetAddress,
    acurastSigner,
    yieldSource,
    counterparty,
    autocompounderAddress, // wire autocompounder at deploy time
    { gasLimit: 6_000_000 }
  );
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  console.log("✅ YieldSenseKeeper deployed →", keeperAddress);

  // ─── 4. Wire: set Keeper as the Autocompounder's authorized caller ────────────
  if (POOL_ADDRESS && GAUGE_ADDRESS) {
    console.log("\nWiring autocompounder.setKeeper →", keeperAddress);
    const compounder = await hre.ethers.getContractAt("AerodromeAutocompounder", autocompounderAddress);
    await (await compounder.setKeeper(keeperAddress, { gasLimit: 100_000 })).wait();
    console.log("✅ Keeper authorized on Autocompounder");
  }

  // ─── 5. Attest deployer as TEE processor (testnet bootstrapping) ───────────────
  console.log("\nAttesting deployer as trusted TEE processor and primary user...");
  await (await keeper.ownerAttestProcessor(deployer.address, { gasLimit: 100_000 })).wait();
  await (await keeper.setPrimaryUser(deployer.address, { gasLimit: 100_000 })).wait();
  console.log("✅ Deployer attested and set as primaryUser");

  // ─── 6. P-256 attestation root (testnet placeholder) ─────────────────────────
  if (isTestnet) {
    const dummyQx = "0x" + "a".repeat(64);
    const dummyQy = "0x" + "b".repeat(64);
    await (await keeper.setAttestationRoot(dummyQx, dummyQy, { gasLimit: 100_000 })).wait();
    console.log("✅ P-256 attestation root set (testnet placeholder)");
  }

  // ─── 7. Approve Keeper to spend asset (for yieldSource pull in executeTrade) ──
  if (isTestnet) {
    const asset = await hre.ethers.getContractAt(
      ["function approve(address,uint256) external returns (bool)"],
      assetAddress
    );
    await (await asset.approve(keeperAddress, hre.ethers.MaxUint256, { gasLimit: 100_000 })).wait();
    console.log("✅ Keeper approved for MockUSDC");
  }

  // ─── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║   COPY THESE TO: frontend/.env.local  +  .env     ║");
  console.log("╚════════════════════════════════════════════════════╝");
  console.log(`NEXT_PUBLIC_KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`NEXT_PUBLIC_ASSET_ADDRESS=${assetAddress}`);
  console.log(`NEXT_PUBLIC_AUTOCOMPOUNDER_ADDRESS=${autocompounderAddress}`);
  console.log("");
  console.log(`KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`POOL_ADDRESS=${POOL_ADDRESS || "<set real pool>"}`);
  console.log(`GAUGE_ADDRESS=${GAUGE_ADDRESS || "<set real gauge>"}`);
  console.log(`ASSET_ADDRESS=${assetAddress}`);
  console.log(`AUTOCOMPOUNDER_ADDRESS=${autocompounderAddress}`);
  console.log(`HARVEST_MIN_ASSET_OUT=0`);
  console.log("\n✅ Full stack deployment complete.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
