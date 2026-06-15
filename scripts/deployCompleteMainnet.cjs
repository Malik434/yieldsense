/**
 * Deploy the complete YieldSense mainnet testing stack:
 * - ExecutorRegistry
 * - AerodromeAutocompounder
 * - YieldSenseKeeper
 * - GridVault
 * - GridStrategyManager
 * - GridExecutionRouter
 *
 * Ownership intentionally remains with the deployer EOA unless
 * PROTOCOL_OWNER_ADDRESS is set.
 */

"use strict";

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const USDC_ADDRESS =
  process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO_ADDRESS =
  process.env.AERO_ADDRESS || "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const WETH_ADDRESS =
  process.env.WETH_ADDRESS || "0x4200000000000000000000000000000000000006";
const ROUTER_ADDRESS =
  process.env.ROUTER_ADDRESS || "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const FACTORY_ADDRESS =
  process.env.FACTORY_ADDRESS || "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const POOL_ADDRESS =
  process.env.POOL_ADDRESS || "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const GAUGE_ADDRESS =
  process.env.GAUGE_ADDRESS || "0x4F09bAb2f0E15e2A078A227FE1537665F55b8360";
const GRID_ETH_USDC_PRICE_POOL_ADDRESS =
  process.env.GRID_ETH_USDC_PRICE_POOL_ADDRESS ||
  process.env.ETH_USDC_GRID_POOL_ADDRESS ||
  process.env.UNISWAP_POOL_ADDRESS ||
  "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";

function parseUsdc(value, fallback) {
  return hre.ethers.parseUnits(process.env[value] || fallback, 6);
}

function assertAddress(name, value) {
  if (!hre.ethers.isAddress(value)) {
    throw new Error(`${name} must be configured with a valid address.`);
  }
  return value;
}

async function registerIfSet(registry, roleName, envName) {
  const processor = process.env[envName]?.trim();
  if (!processor) return null;
  const role = await registry[roleName]();
  const deploymentHash =
    process.env[`${envName}_DEPLOYMENT_HASH`] || hre.ethers.ZeroHash;
  const codeHash = process.env[`${envName}_CODE_HASH`] || hre.ethers.ZeroHash;
  await (
    await registry.registerProcessor(
      processor,
      role,
      deploymentHash,
      codeHash,
      { gasLimit: 180_000 },
    )
  ).wait();
  console.log(`Registered ${envName} as ${roleName}:`, processor);
  return processor;
}

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== 8453)
    throw new Error(`Expected Base mainnet chainId=8453, got ${chainId}`);

  const [deployer] = await hre.ethers.getSigners();
  const ownerAddress =
    process.env.PROTOCOL_OWNER_ADDRESS?.trim() || deployer.address;
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\nYieldSense complete mainnet deployment");
  console.log("Network :", network.name, `(chainId: ${chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Owner   :", ownerAddress);
  console.log("Balance :", hre.ethers.formatEther(balance), "ETH\n");

  if (
    balance < hre.ethers.parseEther(process.env.MIN_DEPLOYER_ETH || "0.0004")
  ) {
    throw new Error("Deployer balance is too low for complete deployment.");
  }

  const Registry = await hre.ethers.getContractFactory("ExecutorRegistry");
  const registry = await Registry.deploy(deployer.address, {
    gasLimit: 1_500_000,
  });
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("ExecutorRegistry:", registryAddress);

  const Autocompounder = await hre.ethers.getContractFactory(
    "AerodromeAutocompounder",
  );
  const autocompounder = await Autocompounder.deploy(
    POOL_ADDRESS,
    GAUGE_ADDRESS,
    USDC_ADDRESS,
    AERO_ADDRESS,
    ROUTER_ADDRESS,
    FACTORY_ADDRESS,
    deployer.address,
    { gasLimit: 5_500_000 },
  );
  await autocompounder.waitForDeployment();
  const autocompounderAddress = await autocompounder.getAddress();
  console.log("AerodromeAutocompounder:", autocompounderAddress);

  const Keeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await Keeper.deploy(
    USDC_ADDRESS,
    AERO_ADDRESS,
    deployer.address,
    autocompounderAddress,
    registryAddress,
    { gasLimit: 6_000_000 },
  );
  await keeper.waitForDeployment();
  const keeperAddress = await keeper.getAddress();
  console.log("YieldSenseKeeper:", keeperAddress);

  await (
    await autocompounder.setKeeper(keeperAddress, { gasLimit: 120_000 })
  ).wait();
  console.log("Autocompounder keeper set.");

  const maxTotalAssets = parseUsdc("MAX_TOTAL_ASSETS_USDC", "500");
  await (
    await keeper.setMaxTotalAssets(maxTotalAssets, { gasLimit: 120_000 })
  ).wait();
  console.log("Keeper cap:", hre.ethers.formatUnits(maxTotalAssets, 6), "USDC");

  const GridVault = await hre.ethers.getContractFactory("GridVault");
  const gridVault = await GridVault.deploy(deployer.address, {
    gasLimit: 2_500_000,
  });
  await gridVault.waitForDeployment();
  const gridVaultAddress = await gridVault.getAddress();
  console.log("GridVault:", gridVaultAddress);

  const GridStrategyManager = await hre.ethers.getContractFactory(
    "GridStrategyManager",
  );
  const gridStrategyManager = await GridStrategyManager.deploy(
    deployer.address,
    gridVaultAddress,
    { gasLimit: 4_000_000 },
  );
  await gridStrategyManager.waitForDeployment();
  const gridStrategyManagerAddress = await gridStrategyManager.getAddress();
  console.log("GridStrategyManager:", gridStrategyManagerAddress);

  const GridExecutionRouter = await hre.ethers.getContractFactory(
    "GridExecutionRouter",
  );
  const gridExecutionRouter = await GridExecutionRouter.deploy(
    deployer.address,
    registryAddress,
    gridStrategyManagerAddress,
    gridVaultAddress,
    { gasLimit: 4_000_000 },
  );
  await gridExecutionRouter.waitForDeployment();
  const gridExecutionRouterAddress = await gridExecutionRouter.getAddress();
  console.log("GridExecutionRouter:", gridExecutionRouterAddress);

  const aeroUsdcPairId = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("AERO-USDC"),
  );
  const ethUsdcPairId = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("ETH-USDC"),
  );
  const acuAddress = process.env.ACU_ADDRESS?.trim();
  const acuUsdcPairId = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("ACU-USDC"),
  );
  const minGasReserve = parseUsdc("GRID_MIN_GAS_RESERVE_USDC", "1");
  const maxGasCost = parseUsdc("GRID_MAX_GAS_COST_USDC", "2");
  const minExecutionInterval = Number(
    process.env.GRID_MIN_EXECUTION_INTERVAL_SEC || "60",
  );

  await (
    await gridVault.setSupportedToken(USDC_ADDRESS, true, { gasLimit: 100_000 })
  ).wait();
  await (
    await gridVault.setSupportedToken(AERO_ADDRESS, true, { gasLimit: 100_000 })
  ).wait();
  await (
    await gridVault.setSupportedToken(WETH_ADDRESS, true, { gasLimit: 100_000 })
  ).wait();
  if (acuAddress) {
    assertAddress("ACU_ADDRESS", acuAddress);
    await (
      await gridVault.setSupportedToken(acuAddress, true, { gasLimit: 100_000 })
    ).wait();
  }
  await (
    await gridVault.setManager(gridStrategyManagerAddress, {
      gasLimit: 100_000,
    })
  ).wait();
  await (
    await gridVault.setExecutionRouter(gridExecutionRouterAddress, {
      gasLimit: 100_000,
    })
  ).wait();
  console.log("GridVault wired.");

  await (
    await gridStrategyManager.setExecutionRouter(gridExecutionRouterAddress, {
      gasLimit: 100_000,
    })
  ).wait();
  const configuredGridPairs = [
    { label: "AERO/USDC", pairId: aeroUsdcPairId, baseToken: AERO_ADDRESS },
    { label: "ETH/USDC", pairId: ethUsdcPairId, baseToken: WETH_ADDRESS },
  ];
  if (acuAddress) {
    configuredGridPairs.push({
      label: "ACU/USDC",
      pairId: acuUsdcPairId,
      baseToken: acuAddress,
    });
  }

  for (const pair of configuredGridPairs) {
    await (
      await gridStrategyManager.configurePair(
        pair.pairId,
        pair.baseToken,
        USDC_ADDRESS,
        true,
        minGasReserve,
        maxGasCost,
        minExecutionInterval,
        { gasLimit: 180_000 },
      )
    ).wait();
    await (
      await gridExecutionRouter.setPairAllowed(pair.pairId, true, {
        gasLimit: 100_000,
      })
    ).wait();
    console.log(`Grid pair configured: ${pair.label} ${pair.pairId}`);
  }

  await (
    await gridExecutionRouter.setRouterAllowed(ROUTER_ADDRESS, true, {
      gasLimit: 100_000,
    })
  ).wait();
  console.log("GridExecutionRouter allowlists configured.");

  await registerIfSet(registry, "YIELD_EXECUTOR", "YIELD_PROCESSOR_ADDRESS");
  await registerIfSet(registry, "GRID_EXECUTOR", "GRID_PROCESSOR_ADDRESS");

  if (ownerAddress.toLowerCase() !== deployer.address.toLowerCase()) {
    await (
      await registry.transferOwnership(ownerAddress, { gasLimit: 100_000 })
    ).wait();
    await (
      await autocompounder.transferOwnership(ownerAddress, {
        gasLimit: 100_000,
      })
    ).wait();
    await (
      await keeper.transferOwnership(ownerAddress, { gasLimit: 100_000 })
    ).wait();
    await (
      await gridVault.transferOwnership(ownerAddress, { gasLimit: 100_000 })
    ).wait();
    await (
      await gridStrategyManager.transferOwnership(ownerAddress, {
        gasLimit: 100_000,
      })
    ).wait();
    await (
      await gridExecutionRouter.transferOwnership(ownerAddress, {
        gasLimit: 100_000,
      })
    ).wait();
    console.log("Ownership transfers initiated after wiring.");
  } else {
    console.log("Keeping deployer EOA as testing owner.");
  }

  const deploymentBlock = await hre.ethers.provider.getBlockNumber();
  let gitCommit = "unknown";
  try {
    gitCommit = execSync("git rev-parse --short HEAD", {
      stdio: ["pipe", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch (_) {}

  const manifest = {
    network: "baseMainnet",
    chainId,
    deployer: deployer.address,
    owner: ownerAddress,
    executorRegistry: registryAddress,
    yieldSenseKeeper: keeperAddress,
    aerodromeAutocompounder: autocompounderAddress,
    gridVault: gridVaultAddress,
    gridStrategyManager: gridStrategyManagerAddress,
    gridExecutionRouter: gridExecutionRouterAddress,
    gridPairs: configuredGridPairs.map((pair) => ({
      label: pair.label,
      pairId: pair.pairId,
      baseToken: pair.baseToken,
      quoteToken: USDC_ADDRESS,
    })),
    usdc: USDC_ADDRESS,
    aero: AERO_ADDRESS,
    weth: WETH_ADDRESS,
    acu: acuAddress || null,
    router: ROUTER_ADDRESS,
    factory: FACTORY_ADDRESS,
    pool: POOL_ADDRESS,
    gauge: GAUGE_ADDRESS,
    gridEthUsdcPricePool: GRID_ETH_USDC_PRICE_POOL_ADDRESS,
    deploymentBlock,
    gitCommit,
    timestamp: new Date().toISOString(),
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir))
    fs.mkdirSync(deploymentsDir, { recursive: true });
  const manifestPath = path.join(deploymentsDir, "base-mainnet-complete.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log("\nCopy to frontend env:");
  console.log(`NEXT_PUBLIC_MAINNET_KEEPER_ADDRESS=${keeperAddress}`);
  console.log(
    `NEXT_PUBLIC_MAINNET_EXECUTOR_REGISTRY_ADDRESS=${registryAddress}`,
  );
  console.log(
    `NEXT_PUBLIC_MAINNET_AUTOCOMPOUNDER_ADDRESS=${autocompounderAddress}`,
  );
  console.log(`NEXT_PUBLIC_MAINNET_GRID_VAULT_ADDRESS=${gridVaultAddress}`);
  console.log(
    `NEXT_PUBLIC_MAINNET_GRID_STRATEGY_MANAGER_ADDRESS=${gridStrategyManagerAddress}`,
  );
  console.log(
    `NEXT_PUBLIC_MAINNET_GRID_EXECUTION_ROUTER_ADDRESS=${gridExecutionRouterAddress}`,
  );
  console.log(`NEXT_PUBLIC_MAINNET_ASSET_ADDRESS=${USDC_ADDRESS}`);
  console.log(
    `NEXT_PUBLIC_ETH_USDC_GRID_POOL_ADDRESS=${GRID_ETH_USDC_PRICE_POOL_ADDRESS}`,
  );
  if (acuAddress) {
    console.log(`NEXT_PUBLIC_ACU_TOKEN_ADDRESS=${acuAddress}`);
    console.log(
      `NEXT_PUBLIC_ACU_USDC_POOL_ADDRESS=${process.env.ACU_USDC_POOL_ADDRESS || ""}`,
    );
  }

  console.log("\nCopy to Acurast/grid processor env:");
  console.log("ENABLE_LIVE_GRID_EXECUTOR=true");
  console.log(`GRID_STRATEGY_MANAGER_ADDRESS=${gridStrategyManagerAddress}`);
  console.log(`GRID_EXECUTION_ROUTER_ADDRESS=${gridExecutionRouterAddress}`);
  console.log(`GRID_POOL_ADDRESS=${GRID_ETH_USDC_PRICE_POOL_ADDRESS}`);
  console.log(`GRID_PAIR_ID=${ethUsdcPairId}`);
  console.log(
    `RPC_URL=${process.env.RPC_URL || process.env.BASE_MAINNET_RPC || "https://mainnet.base.org"}`,
  );
  console.log(
    `DATA_RPC_URL=${process.env.DATA_RPC_URL || process.env.BASE_MAINNET_RPC || "https://mainnet.base.org"}`,
  );
  console.log(`KEEPER_ADDRESS=${keeperAddress}`);
  console.log(`EXECUTOR_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`GRID_AERO_USDC_PAIR_ID=${aeroUsdcPairId}`);
  console.log(`GRID_ETH_USDC_PAIR_ID=${ethUsdcPairId}`);
  if (acuAddress) console.log(`GRID_ACU_USDC_PAIR_ID=${acuUsdcPairId}`);

  console.log("\nVerification commands:");
  console.log(
    `npx hardhat verify --network baseMainnet ${registryAddress} ${ownerAddress}`,
  );
  console.log(
    `npx hardhat verify --network baseMainnet ${autocompounderAddress} ${POOL_ADDRESS} ${GAUGE_ADDRESS} ${USDC_ADDRESS} ${AERO_ADDRESS} ${ROUTER_ADDRESS} ${FACTORY_ADDRESS} ${deployer.address}`,
  );
  console.log(
    `npx hardhat verify --network baseMainnet ${keeperAddress} ${USDC_ADDRESS} ${AERO_ADDRESS} ${deployer.address} ${autocompounderAddress} ${registryAddress}`,
  );
  console.log(
    `npx hardhat verify --network baseMainnet ${gridVaultAddress} ${ownerAddress}`,
  );
  console.log(
    `npx hardhat verify --network baseMainnet ${gridStrategyManagerAddress} ${ownerAddress} ${gridVaultAddress}`,
  );
  console.log(
    `npx hardhat verify --network baseMainnet ${gridExecutionRouterAddress} ${ownerAddress} ${registryAddress} ${gridStrategyManagerAddress} ${gridVaultAddress}`,
  );

  console.log("\nManifest:", manifestPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
