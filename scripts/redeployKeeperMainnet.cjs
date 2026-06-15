"use strict";

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const MANIFEST_PATH = process.env.DEPLOYMENT_MANIFEST ||
  path.join(__dirname, "..", "deployments", "base-mainnet-complete.json");
const ROOT_ENV_PATH = path.join(__dirname, "..", ".env");
const FRONTEND_ENV_PATH = path.join(__dirname, "..", "frontend", ".env.local");

function parseUsdc(value, fallback) {
  return hre.ethers.parseUnits(process.env[value] || fallback, 6);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function resolveManifestAddress(manifest, key, envKey) {
  const manifestAddress = hre.ethers.getAddress(manifest[key]);
  const envValue = process.env[envKey];
  if (!envValue) return manifestAddress;

  const envAddress = hre.ethers.getAddress(envValue);
  if (envAddress.toLowerCase() === manifestAddress.toLowerCase()) {
    return manifestAddress;
  }

  if (process.env.ALLOW_MANIFEST_ADDRESS_OVERRIDE === "YES") {
    console.log(`WARN: overriding manifest ${key} with ${envKey}: ${envAddress}`);
    return envAddress;
  }

  throw new Error(
    `${envKey} (${envAddress}) differs from manifest.${key} (${manifestAddress}). ` +
      "Update the manifest/env first, or set ALLOW_MANIFEST_ADDRESS_OVERRIDE=YES intentionally."
  );
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

async function main() {
  if (process.env.REDEPLOY_KEEPER_CONFIRM !== "YES") {
    console.log("Dry guard active. This script deploys and rewires mainnet contracts.");
    console.log("Rerun with: REDEPLOY_KEEPER_CONFIRM=YES npx hardhat run scripts/redeployKeeperMainnet.cjs --network baseMainnet");
    return;
  }

  const network = await hre.ethers.provider.getNetwork();
  if (Number(network.chainId) !== 8453) {
    throw new Error(`Expected Base mainnet chainId=8453, got ${network.chainId}`);
  }

  const manifest = loadManifest();
  const [deployer] = await hre.ethers.getSigners();
  const oldKeeperAddress = hre.ethers.getAddress(process.env.OLD_KEEPER_ADDRESS || manifest.yieldSenseKeeper);
  const autocompounderAddress = resolveManifestAddress(manifest, "aerodromeAutocompounder", "AUTOCOMPOUNDER_ADDRESS");
  const registryAddress = resolveManifestAddress(manifest, "executorRegistry", "EXECUTOR_REGISTRY_ADDRESS");
  const assetAddress = resolveManifestAddress(manifest, "usdc", "USDC_ADDRESS");
  const rewardTokenAddress = resolveManifestAddress(manifest, "aero", "AERO_ADDRESS");
  const counterparty = hre.ethers.getAddress(process.env.COUNTERPARTY_ADDRESS || deployer.address);

  console.log("\nRedeploying YieldSenseKeeper only");
  console.log("Network        :", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer       :", deployer.address);
  console.log("Old keeper     :", oldKeeperAddress);
  console.log("Autocompounder :", autocompounderAddress);
  console.log("Registry       :", registryAddress);
  console.log("Asset          :", assetAddress);
  console.log("Reward         :", rewardTokenAddress);

  const oldKeeper = await hre.ethers.getContractAt("YieldSenseKeeper", oldKeeperAddress);
  const oldTotalSupply = await oldKeeper.totalSupply();
  const oldTotalAssets = await oldKeeper.totalAssets();
  if (oldTotalSupply !== 0n || oldTotalAssets !== 0n) {
    throw new Error(
      `Old keeper is not settled. totalSupply=${oldTotalSupply.toString()} totalAssets=${oldTotalAssets.toString()}`
    );
  }

  const autocompounder = await hre.ethers.getContractAt("AerodromeAutocompounder", autocompounderAddress);
  const currentAcKeeper = await autocompounder.keeper();
  if (currentAcKeeper.toLowerCase() !== oldKeeperAddress.toLowerCase()) {
    console.log("WARN: autocompounder.keeper() is not old keeper:", currentAcKeeper);
  }

  const Keeper = await hre.ethers.getContractFactory("YieldSenseKeeper");
  const keeper = await Keeper.deploy(
    assetAddress,
    rewardTokenAddress,
    counterparty,
    autocompounderAddress,
    registryAddress,
    { gasLimit: 6_000_000 }
  );
  await keeper.waitForDeployment();
  const newKeeperAddress = await keeper.getAddress();
  console.log("New keeper     :", newKeeperAddress);

  await (await autocompounder.setKeeper(newKeeperAddress, { gasLimit: 120_000 })).wait();
  console.log("Autocompounder keeper updated.");

  const maxTotalAssets = parseUsdc("MAX_TOTAL_ASSETS_USDC", "500");
  await (await keeper.setMaxTotalAssets(maxTotalAssets, { gasLimit: 120_000 })).wait();
  console.log("Keeper cap     :", hre.ethers.formatUnits(maxTotalAssets, 6), "USDC");

  const deploymentBlock = await hre.ethers.provider.getBlockNumber();
  manifest.previousYieldSenseKeeper = oldKeeperAddress;
  manifest.yieldSenseKeeper = newKeeperAddress;
  manifest.aerodromeAutocompounder = autocompounderAddress;
  manifest.keeperRedeployedAt = new Date().toISOString();
  manifest.keeperRedeploymentBlock = deploymentBlock;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log("Manifest updated:", MANIFEST_PATH);

  upsertEnvValue(ROOT_ENV_PATH, "KEEPER_ADDRESS", newKeeperAddress);
  upsertEnvValue(ROOT_ENV_PATH, "NEXT_PUBLIC_MAINNET_KEEPER_ADDRESS", newKeeperAddress);
  upsertEnvValue(ROOT_ENV_PATH, "AUTOCOMPOUNDER_ADDRESS", autocompounderAddress);
  upsertEnvValue(ROOT_ENV_PATH, "NEXT_PUBLIC_MAINNET_AUTOCOMPOUNDER_ADDRESS", autocompounderAddress);
  upsertEnvValue(FRONTEND_ENV_PATH, "NEXT_PUBLIC_KEEPER_ADDRESS", newKeeperAddress);
  upsertEnvValue(FRONTEND_ENV_PATH, "NEXT_PUBLIC_AUTOCOMPOUNDER_ADDRESS", autocompounderAddress);
  upsertEnvValue(FRONTEND_ENV_PATH, "NEXT_PUBLIC_MAINNET_KEEPER_ADDRESS", newKeeperAddress);
  upsertEnvValue(FRONTEND_ENV_PATH, "NEXT_PUBLIC_MAINNET_AUTOCOMPOUNDER_ADDRESS", autocompounderAddress);
  console.log(".env files updated.");

  console.log("\nVerification command:");
  console.log(`npx hardhat verify --network baseMainnet ${newKeeperAddress} ${assetAddress} ${rewardTokenAddress} ${counterparty} ${autocompounderAddress} ${registryAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
