"use strict";

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const MANIFEST_PATH =
  process.env.DEPLOYMENT_MANIFEST ||
  path.join(__dirname, "..", "deployments", "base-mainnet-complete.json");
const ROOT_ENV_PATH = path.join(__dirname, "..", ".env");
const FRONTEND_ENV_PATH = path.join(__dirname, "..", "frontend", ".env.local");
const CONFIRM = process.env.GRID_UPGRADE_CONFIRM === "YES";

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Deployment manifest not found: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function parseUsdc(key, fallback) {
  return hre.ethers.parseUnits(process.env[key] || fallback, 6);
}

function upsertEnvValue(filePath, key, value) {
  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) {
    text = text.replace(pattern, line);
  } else {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text += `${line}\n`;
  }
  fs.writeFileSync(filePath, text);
}

async function wait(tx, label) {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  return receipt;
}

async function main() {
  if (!CONFIRM) {
    console.log("Dry guard active. This script deploys and rewires mainnet grid contracts.");
    console.log("Rerun with: GRID_UPGRADE_CONFIRM=YES npm run upgrade:grid");
    return;
  }

  const manifest = loadManifest();
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  if (Number(network.chainId) !== 8453) {
    throw new Error(`Expected Base mainnet chainId=8453, got ${network.chainId}`);
  }

  const owner = hre.ethers.getAddress(process.env.PROTOCOL_OWNER_ADDRESS || manifest.owner || deployer.address);
  const gridVaultAddress = hre.ethers.getAddress(process.env.GRID_VAULT_ADDRESS || manifest.gridVault);
  const executorRegistryAddress = hre.ethers.getAddress(process.env.EXECUTOR_REGISTRY_ADDRESS || manifest.executorRegistry);
  const routerAddress = hre.ethers.getAddress(process.env.ROUTER_ADDRESS || manifest.router);
  const usdcAddress = hre.ethers.getAddress(process.env.USDC_ADDRESS || manifest.usdc);
  const previousManager = hre.ethers.getAddress(manifest.gridStrategyManager);
  const previousRouter = hre.ethers.getAddress(manifest.gridExecutionRouter);
  const minGasReserve = parseUsdc("GRID_MIN_GAS_RESERVE_USDC", "1");
  const maxGasCost = parseUsdc("GRID_MAX_GAS_COST_USDC", "2");
  const minExecutionInterval = Number(process.env.GRID_MIN_EXECUTION_INTERVAL_SEC || "60");

  console.log("\nYieldSense grid mainnet upgrade");
  console.log("Network         :", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer        :", deployer.address);
  console.log("Owner           :", owner);
  console.log("GridVault       :", gridVaultAddress);
  console.log("Old manager     :", previousManager);
  console.log("Old router      :", previousRouter);
  console.log("ExecutorRegistry:", executorRegistryAddress);

  const GridStrategyManager = await hre.ethers.getContractFactory("GridStrategyManager");
  const manager = await GridStrategyManager.deploy(owner, gridVaultAddress, { gasLimit: 4_500_000 });
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();
  console.log("New manager     :", managerAddress);

  const GridExecutionRouter = await hre.ethers.getContractFactory("GridExecutionRouter");
  const executionRouter = await GridExecutionRouter.deploy(
    owner,
    executorRegistryAddress,
    managerAddress,
    gridVaultAddress,
    { gasLimit: 4_500_000 },
  );
  await executionRouter.waitForDeployment();
  const executionRouterAddress = await executionRouter.getAddress();
  console.log("New router      :", executionRouterAddress);

  const gridVault = await hre.ethers.getContractAt("GridVault", gridVaultAddress);

  console.log("Rewiring GridVault manager...");
  await wait(await gridVault.setManager(managerAddress, { gasLimit: 120_000 }), "GridVault.setManager");
  console.log("Rewiring GridVault execution router...");
  await wait(await gridVault.setExecutionRouter(executionRouterAddress, { gasLimit: 120_000 }), "GridVault.setExecutionRouter");

  console.log("Setting manager execution router...");
  await wait(await manager.setExecutionRouter(executionRouterAddress, { gasLimit: 120_000 }), "manager.setExecutionRouter");

  const pairs = Array.isArray(manifest.gridPairs) ? manifest.gridPairs : [];
  if (pairs.length === 0) throw new Error("No gridPairs found in manifest.");

  for (const pair of pairs) {
    const pairId = pair.pairId;
    const baseToken = hre.ethers.getAddress(pair.baseToken);
    const quoteToken = hre.ethers.getAddress(pair.quoteToken || usdcAddress);
    console.log(`Configuring pair ${pair.label || pairId}...`);
    await wait(
      await manager.configurePair(
        pairId,
        baseToken,
        quoteToken,
        true,
        minGasReserve,
        maxGasCost,
        minExecutionInterval,
        { gasLimit: 180_000 },
      ),
      `manager.configurePair(${pair.label || pairId})`,
    );
    await wait(
      await executionRouter.setPairAllowed(pairId, true, { gasLimit: 100_000 }),
      `router.setPairAllowed(${pair.label || pairId})`,
    );
  }

  console.log("Allowing Aerodrome router...");
  await wait(await executionRouter.setRouterAllowed(routerAddress, true, { gasLimit: 100_000 }), "router.setRouterAllowed");

  const blockNumber = await hre.ethers.provider.getBlockNumber();
  manifest.previousGridStrategyManager = previousManager;
  manifest.previousGridExecutionRouter = previousRouter;
  manifest.gridStrategyManager = managerAddress;
  manifest.gridExecutionRouter = executionRouterAddress;
  manifest.gridUpgradedAt = new Date().toISOString();
  manifest.gridUpgradeBlock = blockNumber;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log("Manifest updated:", MANIFEST_PATH);

  upsertEnvValue(ROOT_ENV_PATH, "GRID_STRATEGY_MANAGER_ADDRESS", managerAddress);
  upsertEnvValue(ROOT_ENV_PATH, "GRID_EXECUTION_ROUTER_ADDRESS", executionRouterAddress);
  upsertEnvValue(ROOT_ENV_PATH, "NEXT_PUBLIC_MAINNET_GRID_STRATEGY_MANAGER_ADDRESS", managerAddress);
  upsertEnvValue(ROOT_ENV_PATH, "NEXT_PUBLIC_MAINNET_GRID_EXECUTION_ROUTER_ADDRESS", executionRouterAddress);
  upsertEnvValue(FRONTEND_ENV_PATH, "NEXT_PUBLIC_MAINNET_GRID_STRATEGY_MANAGER_ADDRESS", managerAddress);
  upsertEnvValue(FRONTEND_ENV_PATH, "NEXT_PUBLIC_MAINNET_GRID_EXECUTION_ROUTER_ADDRESS", executionRouterAddress);
  upsertEnvValue(FRONTEND_ENV_PATH, "NEXT_PUBLIC_SMOKE_GRID_STRATEGY_ID", "");
  console.log(".env files updated.");

  console.log("\nVerification commands:");
  console.log(`npx hardhat verify --network baseMainnet ${managerAddress} ${owner} ${gridVaultAddress}`);
  console.log(`npx hardhat verify --network baseMainnet ${executionRouterAddress} ${owner} ${executorRegistryAddress} ${managerAddress} ${gridVaultAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
