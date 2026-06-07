"use strict";

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const MANIFEST_PATH =
  process.env.DEPLOYMENT_MANIFEST ||
  path.join(__dirname, "..", "deployments", "base-mainnet-complete.json");
const CONFIRM = process.env.GRID_RECOVERY_CONFIRM === "YES";
const WITHDRAW_AFTER_RELEASE = process.env.GRID_RECOVERY_WITHDRAW === "true";

const GRID_VAULT_ABI = [
  "function manager() view returns (address)",
  "function setManager(address newManager)",
  "function lockedStrategyBalance(bytes32 strategyId,address token) view returns (uint256)",
  "function availableBalance(address user,address token) view returns (uint256)",
  "function withdraw(address token,uint256 amount)",
];

const RECOVERY_ABI = [
  "function releaseStrategyInventory(bytes32 strategyId,address user,address[] tokens,uint256[] amounts)",
];

const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const STRATEGY_MANAGER_ABI = [
  "function pauseStrategy(bytes32 strategyId)",
  "function getStrategy(bytes32 strategyId) view returns (tuple(bytes32 id,address owner,bytes32 pairId,address baseToken,address quoteToken,uint256 allocatedQuote,uint256 quoteBalance,uint256 baseBalance,uint256 avgEntryPrice,int256 realizedPnlQuote,uint256 feesPaidQuote,uint256 gasReserveQuote,uint256 gasSpentQuote,uint256 maxGasCostQuotePerTrade,uint64 lastExecutionAt,int32 currentGridLevel,uint32 strategyVersion,bytes32 encryptedPayloadHash,uint8 status,uint64 createdAt,uint64 updatedAt))",
];

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Deployment manifest not found: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

async function wait(tx, label) {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  return receipt;
}

async function tokenLabel(provider, token) {
  const erc20 = new hre.ethers.Contract(token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  return { symbol, decimals: Number(decimals) };
}

async function main() {
  if (!CONFIRM) {
    console.log("Dry guard active. This script changes GridVault.manager on mainnet.");
    console.log("Rerun with: GRID_RECOVERY_CONFIRM=YES npx hardhat run scripts/recoverGridStrategyMainnet.cjs --network baseMainnet");
    return;
  }

  const manifest = loadManifest();
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  if (Number(network.chainId) !== 8453) {
    throw new Error(`Expected Base mainnet chainId=8453, got ${network.chainId}`);
  }

  const strategyId = process.env.GRID_RECOVERY_STRATEGY_ID || process.env.SMOKE_GRID_STRATEGY_ID;
  if (!strategyId) throw new Error("Set GRID_RECOVERY_STRATEGY_ID or SMOKE_GRID_STRATEGY_ID.");

  const user = hre.ethers.getAddress(process.env.GRID_RECOVERY_USER || deployer.address);
  const gridVaultAddress = hre.ethers.getAddress(process.env.GRID_VAULT_ADDRESS || manifest.gridVault);
  const activeManager = hre.ethers.getAddress(process.env.GRID_STRATEGY_MANAGER_ADDRESS || manifest.gridStrategyManager);
  const tokenList = (process.env.GRID_RECOVERY_TOKENS || `${manifest.usdc},${manifest.aero}`)
    .split(",")
    .map((value) => hre.ethers.getAddress(value.trim()))
    .filter(Boolean);

  const gridVault = new hre.ethers.Contract(gridVaultAddress, GRID_VAULT_ABI, deployer);
  const strategyManager = new hre.ethers.Contract(activeManager, STRATEGY_MANAGER_ABI, deployer);
  const currentManager = hre.ethers.getAddress(await gridVault.manager());

  console.log("\nGrid strategy recovery");
  console.log("Network         :", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer        :", deployer.address);
  console.log("Strategy        :", strategyId);
  console.log("User            :", user);
  console.log("GridVault       :", gridVaultAddress);
  console.log("Current manager :", currentManager);
  console.log("Active manager  :", activeManager);

  let recoveryAddress = process.env.GRID_RECOVERY_MANAGER_ADDRESS;
  if (recoveryAddress) {
    recoveryAddress = hre.ethers.getAddress(recoveryAddress);
  } else {
    const Recovery = await hre.ethers.getContractFactory("GridRecoveryManager");
    const recovery = await Recovery.deploy(deployer.address, gridVaultAddress, { gasLimit: 1_500_000 });
    await recovery.waitForDeployment();
    recoveryAddress = await recovery.getAddress();
    console.log("Recovery manager:", recoveryAddress);
  }

  const tokens = [];
  const amounts = [];
  for (const token of tokenList) {
    const locked = await gridVault.lockedStrategyBalance(strategyId, token);
    const label = await tokenLabel(hre.ethers.provider, token);
    console.log(`Locked ${label.symbol}:`, hre.ethers.formatUnits(locked, label.decimals));
    if (locked > 0n) {
      tokens.push(token);
      amounts.push(locked);
    }
  }

  if (tokens.length === 0) {
    console.log("No locked inventory to recover.");
    return;
  }

  try {
    const strategy = await strategyManager.getStrategy(strategyId);
    if (Number(strategy.status) === 2) {
      console.log("Pausing active legacy strategy before recovery...");
      await wait(await strategyManager.pauseStrategy(strategyId, { gasLimit: 120_000 }), "pauseStrategy");
    }
  } catch (error) {
    console.log("WARN: could not pause legacy strategy:", error instanceof Error ? error.message : String(error));
  }

  if (currentManager.toLowerCase() !== recoveryAddress.toLowerCase()) {
    console.log("Setting GridVault manager to recovery manager...");
    await wait(await gridVault.setManager(recoveryAddress, { gasLimit: 120_000 }), "setManager(recovery)");
  }

  const recovery = new hre.ethers.Contract(recoveryAddress, RECOVERY_ABI, deployer);
  console.log("Releasing locked strategy inventory...");
  await wait(
    await recovery.releaseStrategyInventory(strategyId, user, tokens, amounts, { gasLimit: 300_000 }),
    "releaseStrategyInventory",
  );

  console.log("Restoring GridVault manager...");
  await wait(await gridVault.setManager(activeManager, { gasLimit: 120_000 }), "setManager(active)");

  for (let i = 0; i < tokens.length; i++) {
    const label = await tokenLabel(hre.ethers.provider, tokens[i]);
    const available = await gridVault.availableBalance(user, tokens[i]);
    console.log(`Available ${label.symbol}:`, hre.ethers.formatUnits(available, label.decimals));
    if (WITHDRAW_AFTER_RELEASE && available > 0n) {
      console.log(`Withdrawing ${label.symbol}...`);
      await wait(await gridVault.withdraw(tokens[i], available, { gasLimit: 150_000 }), `withdraw ${label.symbol}`);
    }
  }

  console.log("\nRecovery complete.");
  console.log("Recovery manager verification:");
  console.log(`npx hardhat verify --network baseMainnet ${recoveryAddress} ${deployer.address} ${gridVaultAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
