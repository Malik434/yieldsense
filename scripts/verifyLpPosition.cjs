/**
 * verifyLpPosition.cjs
 *
 * Read-only proof script for the YieldSense Aerodrome LP position.
 *
 * Usage:
 *   npx hardhat run scripts/verifyLpPosition.cjs --network baseMainnet
 *
 * Optional env overrides:
 *   KEEPER_ADDRESS
 *   AUTOCOMPOUNDER_ADDRESS
 *   VERIFY_USER_ADDRESS
 *   USER_ADDRESS
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const COMPLETE_MANIFEST_PATH = path.join(__dirname, "..", "deployments", "base-mainnet-complete.json");
const LEGACY_MANIFEST_PATH = path.join(__dirname, "..", "deployments", "base-mainnet.json");
const MANIFEST_PATH = process.env.DEPLOYMENT_MANIFEST ||
  (fs.existsSync(COMPLETE_MANIFEST_PATH) ? COMPLETE_MANIFEST_PATH : LEGACY_MANIFEST_PATH);
const ENV_PATH = path.join(__dirname, "..", ".env");

const ZERO = "0x0000000000000000000000000000000000000000";

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function balanceOf(address account) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
];

const KEEPER_ABI = [
  "function asset() external view returns (address)",
  "function autocompounder() external view returns (address)",
  "function totalAssets() external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function maxWithdraw(address owner) external view returns (uint256)",
  "function lastHarvest() external view returns (uint256)",
  "function minHarvestProfitUsdc() external view returns (uint256)",
];

const AUTOCOMPOUNDER_ABI = [
  "function keeper() external view returns (address)",
  "function pool() external view returns (address)",
  "function gauge() external view returns (address)",
  "function asset() external view returns (address)",
  "function rewardToken() external view returns (address)",
  "function pendingProfit() external view returns (uint256)",
  "function pendingRewards() external view returns (uint256)",
  "function stakedLpBalance() external view returns (uint256)",
  "function getDeployedValueInUSDC() external view returns (uint256)",
  "function totalStakedLp() external view returns (uint256)",
  "function totalCompounded() external view returns (uint256)",
  "function lastHarvestAt() external view returns (uint256)",
  "function profitShareBps() external view returns (uint256)",
];

const GAUGE_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function earned(address account) external view returns (uint256)",
  "function rewardToken() external view returns (address)",
  "function stakingToken() external view returns (address)",
];

const POOL_ABI = [
  ...ERC20_ABI,
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function stable() external view returns (bool)",
  "function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
];

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireAddress(label, value) {
  if (!value || value === ZERO) {
    throw new Error(`${label} is missing. Set it in .env or deployments/base-mainnet.json.`);
  }
  return ethers.getAddress(value);
}

function fmt(value, decimals, places = 6) {
  const text = ethers.formatUnits(value, decimals);
  const [whole, frac = ""] = text.split(".");
  const trimmed = frac.slice(0, places).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function pct(numerator, denominator) {
  if (denominator === 0n) return "0";
  return `${Number((numerator * 1_000_000n) / denominator) / 10_000}%`;
}

function printKV(label, value) {
  console.log(`${label.padEnd(34)} ${value}`);
}

async function read(label, promise) {
  const timeoutMs = Number(process.env.LP_VERIFY_TIMEOUT_MS || 45_000);
  process.stdout.write(`reading ${label}... `);
  try {
    const value = await Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    console.log("ok");
    return value;
  } catch (error) {
    console.log("failed");
    throw new Error(`${label}: ${error.message}`);
  }
}

async function main() {
  loadEnvFile();

  const manifest = loadManifest();
  const rpcUrl = process.env.BASE_MAINNET_RPC || process.env.RPC_URL || "https://mainnet.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl, 8453, { batchMaxCount: 1 });
  const network = await read("provider.getNetwork()", provider.getNetwork());
  const chainId = Number(network.chainId);

  const keeperAddress = requireAddress(
    "KEEPER_ADDRESS",
    process.env.KEEPER_ADDRESS || manifest.yieldSenseKeeper
  );
  const userAddress = process.env.VERIFY_USER_ADDRESS
    ? ethers.getAddress(process.env.VERIFY_USER_ADDRESS)
    : process.env.USER_ADDRESS
      ? ethers.getAddress(process.env.USER_ADDRESS)
      : null;

  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, provider);

  console.log("");
  console.log("Collecting keeper/autocompounder reads");
  console.log("-".repeat(72));

  const keeperAsset = await read("keeper.asset()", keeper.asset());
  const keeperAutocompounder = await read("keeper.autocompounder()", keeper.autocompounder());
  const totalAssets = await read("keeper.totalAssets()", keeper.totalAssets());
  const totalShares = await read("keeper.totalSupply()", keeper.totalSupply());
  const lastHarvest = await read("keeper.lastHarvest()", keeper.lastHarvest());
  const minHarvestProfit = await read("keeper.minHarvestProfitUsdc()", keeper.minHarvestProfitUsdc());
  const configuredAutocompounder = process.env.AUTOCOMPOUNDER_ADDRESS || manifest.aerodromeAutocompounder;
  const autocompounderAddress = ethers.getAddress(keeperAutocompounder);
  if (configuredAutocompounder && configuredAutocompounder.toLowerCase() !== keeperAutocompounder.toLowerCase()) {
    console.log(
      `WARN: configured autocompounder ${configuredAutocompounder} differs from keeper.autocompounder(); using keeper value ${autocompounderAddress}`
    );
  }
  const autocompounder = new ethers.Contract(autocompounderAddress, AUTOCOMPOUNDER_ABI, provider);
  const acKeeper = await read("autocompounder.keeper()", autocompounder.keeper());
  const poolAddress = await read("autocompounder.pool()", autocompounder.pool());
  const gaugeAddress = await read("autocompounder.gauge()", autocompounder.gauge());
  const acAsset = await read("autocompounder.asset()", autocompounder.asset());
  const rewardTokenAddress = await read("autocompounder.rewardToken()", autocompounder.rewardToken());
  const pendingProfit = await read("autocompounder.pendingProfit()", autocompounder.pendingProfit());
  const pendingRewardsView = await read("autocompounder.pendingRewards()", autocompounder.pendingRewards());
  const stakedLpView = await read("autocompounder.stakedLpBalance()", autocompounder.stakedLpBalance());
  const deployedValue = await read("autocompounder.getDeployedValueInUSDC()", autocompounder.getDeployedValueInUSDC());
  const totalStakedLp = await read("autocompounder.totalStakedLp()", autocompounder.totalStakedLp());
  const totalCompounded = await read("autocompounder.totalCompounded()", autocompounder.totalCompounded());
  const lastHarvestAt = await read("autocompounder.lastHarvestAt()", autocompounder.lastHarvestAt());
  const profitShareBps = await read("autocompounder.profitShareBps()", autocompounder.profitShareBps());

  const asset = new ethers.Contract(keeperAsset, ERC20_ABI, provider);
  const reward = new ethers.Contract(rewardTokenAddress, ERC20_ABI, provider);
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const gauge = new ethers.Contract(gaugeAddress, GAUGE_ABI, provider);

  console.log("");
  console.log("Collecting token/pool/gauge reads");
  console.log("-".repeat(72));

  const assetSymbol = await read("asset.symbol()", asset.symbol());
  const assetDecimals = await read("asset.decimals()", asset.decimals());
  const rewardSymbol = await read("reward.symbol()", reward.symbol());
  const rewardDecimals = await read("reward.decimals()", reward.decimals());
  const token0 = await read("pool.token0()", pool.token0());
  const token1 = await read("pool.token1()", pool.token1());
  const stable = await read("pool.stable()", pool.stable());
  const reserves = await read("pool.getReserves()", pool.getReserves());
  const lpTotalSupply = await read("pool.totalSupply()", pool.totalSupply());
  const lpWalletBalance = await read("pool.balanceOf(autocompounder)", pool.balanceOf(autocompounderAddress));
  const gaugeLpBalance = await read("gauge.balanceOf(autocompounder)", gauge.balanceOf(autocompounderAddress));
  const gaugeEarned = await read("gauge.earned(autocompounder)", gauge.earned(autocompounderAddress));
  const gaugeRewardToken = await read("gauge.rewardToken()", gauge.rewardToken());
  const gaugeStakingToken = await read("gauge.stakingToken()", gauge.stakingToken());
  const keeperAssetBalance = await read("asset.balanceOf(keeper)", asset.balanceOf(keeperAddress));
  const acAssetBalance = await read("asset.balanceOf(autocompounder)", asset.balanceOf(autocompounderAddress));

  const assetIsToken0 = token0.toLowerCase() === keeperAsset.toLowerCase();
  const assetReserve = assetIsToken0 ? reserves.reserve0 : reserves.reserve1;
  const lpValueInAsset = lpTotalSupply === 0n ? 0n : (2n * assetReserve * gaugeLpBalance) / lpTotalSupply;
  const ownershipBps = lpTotalSupply === 0n ? 0n : (gaugeLpBalance * 10_000n) / lpTotalSupply;

  let userBlock = null;
  if (userAddress) {
    const shares = await read("keeper.balanceOf(user)", keeper.balanceOf(userAddress));
    const maxWithdraw = await read("keeper.maxWithdraw(user)", keeper.maxWithdraw(userAddress));
    userBlock = { shares, maxWithdraw };
  }

  console.log("");
  console.log("YieldSense LP Position Proof");
  console.log("=".repeat(72));
  printKV("Network", `${network.name} (${chainId})`);
  printKV("Keeper", keeperAddress);
  printKV("Autocompounder", autocompounderAddress);
  printKV("Pool LP token", poolAddress);
  printKV("Gauge", gaugeAddress);
  printKV("Asset", `${assetSymbol} ${keeperAsset}`);
  printKV("Reward", `${rewardSymbol} ${rewardTokenAddress}`);

  console.log("");
  console.log("Wiring");
  console.log("-".repeat(72));
  printKV("keeper.autocompounder()", keeperAutocompounder);
  printKV("autocompounder.keeper()", acKeeper);
  printKV("autocompounder.asset()", acAsset);
  printKV("gauge.stakingToken()", gaugeStakingToken);
  printKV("gauge.rewardToken()", gaugeRewardToken);

  console.log("");
  console.log("Vault Accounting");
  console.log("-".repeat(72));
  printKV("keeper USDC balance", `${fmt(keeperAssetBalance, assetDecimals)} ${assetSymbol}`);
  printKV("totalAssets()", `${fmt(totalAssets, assetDecimals)} ${assetSymbol}`);
  printKV("totalSupply()", `${fmt(totalShares, assetDecimals)} ysUSDC`);
  printKV("minHarvestProfitUsdc()", `${fmt(minHarvestProfit, assetDecimals)} ${assetSymbol}`);
  printKV("lastHarvest()", lastHarvest.toString());

  if (userBlock) {
    printKV("user", userAddress);
    printKV("user shares", `${fmt(userBlock.shares, assetDecimals)} ysUSDC`);
    printKV("user maxWithdraw", `${fmt(userBlock.maxWithdraw, assetDecimals)} ${assetSymbol}`);
  }

  console.log("");
  console.log("LP Position");
  console.log("-".repeat(72));
  printKV("pool.token0()", token0);
  printKV("pool.token1()", token1);
  printKV("pool.stable()", String(stable));
  printKV("pool totalSupply", fmt(lpTotalSupply, 18));
  printKV("LP in autocompounder wallet", fmt(lpWalletBalance, 18));
  printKV("LP staked in gauge", fmt(gaugeLpBalance, 18));
  printKV("stakedLpBalance()", fmt(stakedLpView, 18));
  printKV("totalStakedLp()", fmt(totalStakedLp, 18));
  printKV("LP share of pool", pct(gaugeLpBalance, lpTotalSupply));
  printKV("reserve0", reserves.reserve0.toString());
  printKV("reserve1", reserves.reserve1.toString());
  printKV("LP value from reserves", `${fmt(lpValueInAsset, assetDecimals)} ${assetSymbol}`);
  printKV("getDeployedValueInUSDC()", `${fmt(deployedValue, assetDecimals)} ${assetSymbol}`);
  printKV("ownership bps", ownershipBps.toString());

  console.log("");
  console.log("Harvest / Yield Proof");
  console.log("-".repeat(72));
  printKV("pendingRewards()", `${fmt(pendingRewardsView, rewardDecimals)} ${rewardSymbol}`);
  printKV("gauge.earned(ac)", `${fmt(gaugeEarned, rewardDecimals)} ${rewardSymbol}`);
  printKV("pendingProfit()", `${fmt(pendingProfit, assetDecimals)} ${assetSymbol}`);
  printKV("autocompounder USDC balance", `${fmt(acAssetBalance, assetDecimals)} ${assetSymbol}`);
  printKV("totalCompounded()", `${fmt(totalCompounded, assetDecimals)} ${assetSymbol}`);
  printKV("lastHarvestAt()", lastHarvestAt.toString());
  printKV("profitShareBps()", profitShareBps.toString());

  console.log("");
  console.log("Interpretation");
  console.log("-".repeat(72));
  if (gaugeLpBalance > 0n && gaugeLpBalance === stakedLpView && gaugeLpBalance === totalStakedLp) {
    console.log("OK: LP tokens are staked in the Aerodrome gauge by the autocompounder.");
  } else if (gaugeLpBalance > 0n) {
    console.log("WARN: Gauge has LP, but accounting counters do not exactly match.");
  } else {
    console.log("WARN: No LP is currently staked in the gauge for this autocompounder.");
  }

  if (pendingProfit >= minHarvestProfit && pendingProfit > 0n) {
    console.log("OK: pendingProfit is large enough for keeper pull on next harvest execution.");
  } else if (pendingProfit > 0n) {
    console.log("INFO: pendingProfit exists but is below minHarvestProfitUsdc.");
  } else {
    console.log("INFO: no unpulled USDC profit is currently pending.");
  }
}

main().catch((error) => {
  console.error("");
  console.error("verifyLpPosition failed:", error.message);
  process.exitCode = 1;
});
