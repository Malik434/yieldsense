"use strict";

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const MANIFEST_PATH =
  process.env.DEPLOYMENT_MANIFEST ||
  path.join(__dirname, "..", "deployments", "base-mainnet-complete.json");
const ROOT_ENV_PATH = path.join(__dirname, "..", ".env");
const FRONTEND_ENV_PATH = path.join(__dirname, "..", "frontend", ".env.local");

const CONFIRM = process.env.GRID_ACU_CONFIRM === "YES";
const ACU_ADDRESS = "0xc5fEd7c8cCC75D8A72b601a66DffD7A489073F0b";
const ACU_USDC_POOL = "0xfea8865c8c9f316584aC4a10346FfE4CD4308351";
const ACU_DECIMALS = "12";

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

function upsertGridPair(manifest, nextPair) {
  const pairs = Array.isArray(manifest.gridPairs) ? manifest.gridPairs : [];
  const index = pairs.findIndex((pair) => String(pair.pairId).toLowerCase() === nextPair.pairId.toLowerCase());
  if (index >= 0) {
    pairs[index] = { ...pairs[index], ...nextPair };
  } else {
    pairs.push(nextPair);
  }
  manifest.gridPairs = pairs;
}

async function main() {
  if (!CONFIRM) {
    console.log("Dry guard active. This script enables ACU/USDC on Base mainnet grid contracts.");
    console.log("Rerun with: GRID_ACU_CONFIRM=YES npm run enable:grid:acu");
    return;
  }

  const manifest = loadManifest();
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  if (Number(network.chainId) !== 8453) {
    throw new Error(`Expected Base mainnet chainId=8453, got ${network.chainId}`);
  }

  const gridVaultAddress = hre.ethers.getAddress(process.env.GRID_VAULT_ADDRESS || manifest.gridVault);
  const managerAddress = hre.ethers.getAddress(process.env.GRID_STRATEGY_MANAGER_ADDRESS || manifest.gridStrategyManager);
  const executionRouterAddress = hre.ethers.getAddress(
    process.env.GRID_EXECUTION_ROUTER_ADDRESS || manifest.gridExecutionRouter,
  );
  const usdcAddress = hre.ethers.getAddress(process.env.USDC_ADDRESS || manifest.usdc);
  const acuAddress = hre.ethers.getAddress(process.env.ACU_ADDRESS || ACU_ADDRESS);
  const acuUsdcPool = hre.ethers.getAddress(process.env.ACU_USDC_POOL_ADDRESS || ACU_USDC_POOL);
  const minGasReserve = parseUsdc("GRID_MIN_GAS_RESERVE_USDC", "1");
  const maxGasCost = parseUsdc("GRID_MAX_GAS_COST_USDC", "2");
  const minExecutionInterval = Number(process.env.GRID_MIN_EXECUTION_INTERVAL_SEC || "60");
  const pairId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("ACU-USDC"));

  console.log("\nYieldSense ACU grid enablement");
  console.log("Network     :", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer    :", deployer.address);
  console.log("GridVault   :", gridVaultAddress);
  console.log("Manager     :", managerAddress);
  console.log("Router      :", executionRouterAddress);
  console.log("ACU         :", acuAddress);
  console.log("USDC        :", usdcAddress);
  console.log("ACU/USDC LP :", acuUsdcPool);
  console.log("Pair ID     :", pairId);

  const gridVault = await hre.ethers.getContractAt("GridVault", gridVaultAddress);
  const manager = await hre.ethers.getContractAt("GridStrategyManager", managerAddress);
  const executionRouter = await hre.ethers.getContractAt("GridExecutionRouter", executionRouterAddress);

  const [tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
    new hre.ethers.Contract(acuAddress, ["function name() view returns (string)"], hre.ethers.provider).name(),
    new hre.ethers.Contract(acuAddress, ["function symbol() view returns (string)"], hre.ethers.provider).symbol(),
    new hre.ethers.Contract(acuAddress, ["function decimals() view returns (uint8)"], hre.ethers.provider).decimals(),
  ]);

  if (tokenSymbol !== "ACU") throw new Error(`Unexpected ACU symbol: ${tokenSymbol}`);
  if (Number(tokenDecimals) !== Number(ACU_DECIMALS)) throw new Error(`Unexpected ACU decimals: ${tokenDecimals}`);
  console.log("Token       :", `${tokenName} (${tokenSymbol}, ${tokenDecimals} decimals)`);

  const supported = await gridVault.supportedToken(acuAddress);
  if (!supported) {
    console.log("Supporting ACU in GridVault...");
    await wait(await gridVault.setSupportedToken(acuAddress, true, { gasLimit: 100_000 }), "GridVault.setSupportedToken(ACU)");
  } else {
    console.log("GridVault already supports ACU.");
  }

  console.log("Configuring ACU/USDC in GridStrategyManager...");
  await wait(
    await manager.configurePair(
      pairId,
      acuAddress,
      usdcAddress,
      true,
      minGasReserve,
      maxGasCost,
      minExecutionInterval,
      { gasLimit: 180_000 },
    ),
    "GridStrategyManager.configurePair(ACU/USDC)",
  );

  console.log("Allowing ACU/USDC in GridExecutionRouter...");
  await wait(
    await executionRouter.setPairAllowed(pairId, true, { gasLimit: 100_000 }),
    "GridExecutionRouter.setPairAllowed(ACU/USDC)",
  );

  upsertGridPair(manifest, {
    label: "ACU/USDC",
    pairId,
    baseToken: acuAddress,
    quoteToken: usdcAddress,
    poolAddress: acuUsdcPool,
    dexRouter: manifest.router,
    factory: manifest.factory,
    stable: false,
    baseDecimals: Number(ACU_DECIMALS),
    quoteDecimals: 6,
  });
  manifest.acu = acuAddress;
  manifest.acuUsdcPool = acuUsdcPool;
  manifest.gridAcuEnabledAt = new Date().toISOString();
  manifest.gridAcuEnabledBlock = await hre.ethers.provider.getBlockNumber();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  for (const filePath of [ROOT_ENV_PATH, FRONTEND_ENV_PATH]) {
    upsertEnvValue(filePath, "ACU_ADDRESS", acuAddress);
    upsertEnvValue(filePath, "ACU_USDC_POOL_ADDRESS", acuUsdcPool);
    upsertEnvValue(filePath, "NEXT_PUBLIC_ACU_TOKEN_ADDRESS", acuAddress);
    upsertEnvValue(filePath, "NEXT_PUBLIC_ACU_USDC_POOL_ADDRESS", acuUsdcPool);
    upsertEnvValue(filePath, "NEXT_PUBLIC_ACU_DECIMALS", ACU_DECIMALS);
    upsertEnvValue(filePath, "NEXT_PUBLIC_ACU_USDC_STABLE", "false");
  }

  console.log("\nACU/USDC grid support enabled.");
  console.log("Restart the frontend so .env.local is reloaded.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
