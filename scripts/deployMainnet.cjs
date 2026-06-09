/**
 * Deploy the capped Base mainnet testing stack.
 *
 * This deployment intentionally keeps ownership with the deployer EOA by
 * default. Set PROTOCOL_OWNER_ADDRESS only if you want to initiate an
 * Ownable2Step transfer to a different testing owner.
 */

"use strict";

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO_ADDRESS = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const ROUTER_ADDRESS = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const FACTORY_ADDRESS = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const POOL_ADDRESS = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const GAUGE_ADDRESS = "0x4F09bAb2f0E15e2A078A227FE1537665F55b8360";

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== 8453) {
    throw new Error(`deployMainnet only runs on Base mainnet. Detected chainId=${chainId}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  const ownerAddress = process.env.PROTOCOL_OWNER_ADDRESS?.trim() || deployer.address;
  const deployerBalance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\nYieldSense capped mainnet testing deployment");
  console.log("Network :", network.name, `(chainId: ${chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Owner   :", ownerAddress);
  console.log("Balance :", hre.ethers.formatEther(deployerBalance), "ETH\n");

  if (deployerBalance < hre.ethers.parseEther("0.002")) {
    throw new Error("Deployer has less than 0.002 ETH on Base.");
  }

  console.log("Deploying ExecutorRegistry...");
  const Registry = await hre.ethers.getContractFactory("ExecutorRegistry");
  const registry = await Registry.deploy(ownerAddress, { gasLimit: 1_500_000 });
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("ExecutorRegistry:", registryAddress);

  console.log("Deploying AerodromeAutocompounder...");
  const Autocompounder = await hre.ethers.getContractFactory("AerodromeAutocompounder");
  const autocompounder = await Autocompounder.deploy(
    POOL_ADDRESS,
    GAUGE_ADDRESS,
    USDC_ADDRESS,
    AERO_ADDRESS,
    ROUTER_ADDRESS,
    FACTORY_ADDRESS,
    deployer.address,
    { gasLimit: 4_500_000 }
  );
  await autocompounder.waitForDeployment();
  const autocompounderAddress = await autocompounder.getAddress();
  console.log("AerodromeAutocompounder:", autocompounderAddress);

  console.log("Deploying YieldSenseKeeper...");
  const Keeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await Keeper.deploy(
    USDC_ADDRESS,
    AERO_ADDRESS,
    deployer.address,
    autocompounderAddress,
    registryAddress,
    { gasLimit: 5_500_000 }
  );
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  console.log("YieldSenseKeeper:", keeperAddress);

  console.log("Wiring autocompounder keeper...");
  await (await autocompounder.setKeeper(keeperAddress, { gasLimit: 100_000 })).wait();

  const initialCap = hre.ethers.parseUnits("500", 6);
  console.log("Setting testing cap to 500 USDC...");
  await (await keeper.setMaxTotalAssets(initialCap, { gasLimit: 100_000 })).wait();

  if (ownerAddress.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log("Initiating ownership transfer to configured owner...");
    await (await autocompounder.transferOwnership(ownerAddress, { gasLimit: 100_000 })).wait();
    await (await keeper.transferOwnership(ownerAddress, { gasLimit: 100_000 })).wait();
  } else {
    console.log("Keeping deployer EOA as testing owner.");
  }

  const deploymentBlock = await hre.ethers.provider.getBlockNumber();
  let gitCommit = "unknown";
  try {
    gitCommit = execSync("git rev-parse --short HEAD", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
  } catch (_) {}

  const manifest = {
    network: "baseMainnet",
    chainId,
    deployer: deployer.address,
    ownerExpected: ownerAddress,
    ownerAccepted: ownerAddress.toLowerCase() === deployer.address.toLowerCase(),
    executorRegistry: registryAddress,
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
    timestamp: new Date().toISOString(),
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const manifestPath = path.join(deploymentsDir, "base-mainnet.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log("\nDeployment complete. Env values:");
  console.log(`NEXT_PUBLIC_KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`NEXT_PUBLIC_AUTOCOMPOUNDER_ADDRESS=${autocompounderAddress}`);
  console.log(`NEXT_PUBLIC_CHAIN_ID=8453`);
  console.log(`NEXT_PUBLIC_ASSET_ADDRESS=${USDC_ADDRESS}`);
  console.log(`EXECUTOR_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`AUTOCOMPOUNDER_ADDRESS=${autocompounderAddress}`);

  console.log("\nVerification commands:");
  console.log(`npx hardhat verify --network baseMainnet ${registryAddress} ${ownerAddress}`);
  console.log(`npx hardhat verify --network baseMainnet ${autocompounderAddress} ${POOL_ADDRESS} ${GAUGE_ADDRESS} ${USDC_ADDRESS} ${AERO_ADDRESS} ${ROUTER_ADDRESS} ${FACTORY_ADDRESS} ${deployer.address}`);
  console.log(`npx hardhat verify --network baseMainnet ${keeperAddress} ${USDC_ADDRESS} ${AERO_ADDRESS} ${deployer.address} ${autocompounderAddress} ${registryAddress}`);

  console.log("\nNext actions:");
  console.log("1. Deploy YieldSenseYieldExecutor and register it with YIELD_EXECUTOR.");
  console.log("2. Deploy YieldSenseGridExecutor and register it with GRID_EXECUTOR.");
  console.log("3. Keep the cap at 20 USDC until smoke tests pass.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
