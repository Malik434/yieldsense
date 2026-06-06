"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const MANIFEST_PATH = process.env.DEPLOYMENT_MANIFEST ||
  path.join(__dirname, "..", "deployments", "base-mainnet-complete.json");
const RPC_URL = process.env.BASE_MAINNET_RPC || process.env.RPC_URL || "https://mainnet.base.org";
const AMOUNT = process.env.SMOKE_USDC_AMOUNT || "1";
const CONFIRM = process.env.SMOKE_CONFIRM === "YES";
const DEPOSIT_FIRST = process.env.SMOKE_DEPOSIT_FIRST !== "false";
const ZAP_BPS = BigInt(process.env.SMOKE_ZAP_BPS || "5000");
const MIN_LP_SLIPPAGE_BPS = BigInt(process.env.SMOKE_MIN_LP_SLIPPAGE_BPS || "1000");
const BPS = 10_000n;

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];

const KEEPER_ABI = [
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function maxDeposit(address owner) view returns (uint256)",
  "function deposit(uint256 assets,address receiver) returns (uint256)",
  "function deployToPool(uint256 amount,uint256 amountToSwap,uint256 minLpOut)",
];

const AUTOCOMPOUNDER_ABI = [
  "function pool() view returns (address)",
  "function gauge() view returns (address)",
  "function router() view returns (address)",
  "function factory() view returns (address)",
  "function stakedLpBalance() view returns (uint256)",
  "function getDeployedValueInUSDC() view returns (uint256)",
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn,tuple(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
  "function quoteAddLiquidity(address tokenA,address tokenB,bool stable,address factory,uint256 amountADesired,uint256 amountBDesired) view returns (uint256 amountA,uint256 amountB,uint256 liquidity)",
];

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Deployment manifest not found: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function applyBps(value, bps) {
  return (value * bps) / BPS;
}

function minAfterSlippage(value, slippageBps) {
  if (slippageBps >= BPS) return 1n;
  const min = (value * (BPS - slippageBps)) / BPS;
  return min > 0n ? min : 1n;
}

async function main() {
  if (!CONFIRM) {
    console.log("Dry guard active. This script sends mainnet transactions.");
    console.log("Rerun with: SMOKE_CONFIRM=YES npm run smoke:yield:pool");
    return;
  }

  if (ZAP_BPS <= 0n || ZAP_BPS >= BPS) {
    throw new Error("SMOKE_ZAP_BPS must be between 1 and 9999.");
  }

  const manifest = loadManifest();
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.SMOKE_PRIVATE_KEY;
  if (!privateKey) throw new Error("Set DEPLOYER_PRIVATE_KEY or SMOKE_PRIVATE_KEY.");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 8453, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(privateKey, provider);
  const keeperAddress = process.env.KEEPER_ADDRESS || manifest.yieldSenseKeeper;
  const autocompounderAddress = process.env.AUTOCOMPOUNDER_ADDRESS || manifest.aerodromeAutocompounder;

  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, wallet);
  const autocompounder = new ethers.Contract(autocompounderAddress, AUTOCOMPOUNDER_ABI, wallet);
  const assetAddress = await keeper.asset();
  const asset = new ethers.Contract(assetAddress, ERC20_ABI, wallet);
  const [symbol, decimals] = await Promise.all([asset.symbol(), asset.decimals()]);
  const amount = ethers.parseUnits(AMOUNT, Number(decimals));

  const [poolAddress, routerAddress, factoryAddress] = await Promise.all([
    autocompounder.pool(),
    autocompounder.router(),
    autocompounder.factory(),
  ]);
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  const [token0, token1, stable] = await Promise.all([pool.token0(), pool.token1(), pool.stable()]);
  const otherToken = token0.toLowerCase() === assetAddress.toLowerCase() ? token1 : token0;

  console.log("\nYield pool smoke test");
  console.log("Wallet         :", wallet.address);
  console.log("Keeper         :", keeperAddress);
  console.log("Autocompounder :", autocompounderAddress);
  console.log("Pool           :", poolAddress);
  console.log("Router         :", routerAddress);
  console.log("Factory        :", factoryAddress);
  console.log("Amount         :", `${AMOUNT} ${symbol}`);

  const keeperIdleBefore = await asset.balanceOf(keeperAddress);
  console.log("Keeper idle before:", ethers.formatUnits(keeperIdleBefore, decimals), symbol);

  if (keeperIdleBefore < amount) {
    if (!DEPOSIT_FIRST) {
      throw new Error(`Keeper idle ${symbol} is below ${AMOUNT}; set SMOKE_DEPOSIT_FIRST=true or deposit first.`);
    }

    const walletBalance = await asset.balanceOf(wallet.address);
    if (walletBalance < amount) {
      throw new Error(`Insufficient wallet ${symbol}. Have ${ethers.formatUnits(walletBalance, decimals)}, need ${AMOUNT}.`);
    }

    const maxDeposit = await keeper.maxDeposit(wallet.address);
    if (maxDeposit < amount) {
      throw new Error(`Vault maxDeposit too low. maxDeposit=${ethers.formatUnits(maxDeposit, decimals)} ${symbol}.`);
    }

    const allowance = await asset.allowance(wallet.address, keeperAddress);
    if (allowance < amount) {
      console.log("Approving keeper...");
      const approveTx = await asset.approve(keeperAddress, amount);
      console.log("approve tx:", approveTx.hash);
      await approveTx.wait();
    }

    console.log("Depositing smoke USDC into keeper...");
    const depositTx = await keeper.deposit(amount, wallet.address);
    console.log("deposit tx:", depositTx.hash);
    await depositTx.wait();
  }

  const amountToSwap = applyBps(amount, ZAP_BPS);
  const assetRemaining = amount - amountToSwap;
  const swapRoute = [{ from: assetAddress, to: otherToken, stable, factory: factoryAddress }];
  const amountsOut = await router.getAmountsOut(amountToSwap, swapRoute);
  const expectedOther = amountsOut[amountsOut.length - 1];
  const quote = await router.quoteAddLiquidity(
    assetAddress,
    otherToken,
    stable,
    factoryAddress,
    assetRemaining,
    expectedOther
  );
  const expectedLiquidity = quote.liquidity ?? quote[2];
  const minLpOut = minAfterSlippage(expectedLiquidity, MIN_LP_SLIPPAGE_BPS);

  console.log("amountToSwap     :", ethers.formatUnits(amountToSwap, decimals), symbol);
  console.log("assetRemaining   :", ethers.formatUnits(assetRemaining, decimals), symbol);
  console.log("expected other   :", expectedOther.toString(), otherToken);
  console.log("expected LP      :", expectedLiquidity.toString());
  console.log("minLpOut         :", minLpOut.toString());
  console.log("LP slippage bps  :", MIN_LP_SLIPPAGE_BPS.toString());

  if (minLpOut === 0n) throw new Error("minLpOut resolved to zero; refusing to deploy.");

  console.log("Calling keeper.deployToPool...");
  const tx = await keeper.deployToPool(amount, amountToSwap, minLpOut);
  console.log("deployToPool tx:", tx.hash);
  await tx.wait();

  const [stakedLp, deployedValue, keeperIdleAfter] = await Promise.all([
    autocompounder.stakedLpBalance(),
    autocompounder.getDeployedValueInUSDC(),
    asset.balanceOf(keeperAddress),
  ]);

  console.log("Keeper idle after :", ethers.formatUnits(keeperIdleAfter, decimals), symbol);
  console.log("Staked LP raw     :", stakedLp.toString());
  console.log("Deployed value    :", ethers.formatUnits(deployedValue, decimals), symbol);
  console.log("\nYield pool smoke test complete. Run `npm run verify:lp` for the full read-only proof.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
