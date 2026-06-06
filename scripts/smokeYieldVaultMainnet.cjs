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
const REDEEM_AFTER_DEPOSIT = process.env.SMOKE_REDEEM_AFTER_DEPOSIT !== "false";
const ONLY_REDEEM_EXISTING = process.env.SMOKE_ONLY_REDEEM === "true";
const UNWIND_BEFORE_REDEEM = process.env.SMOKE_UNWIND_BEFORE_REDEEM === "true";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];

const KEEPER_ABI = [
  "function asset() view returns (address)",
  "function autocompounder() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function maxDeposit(address owner) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function deposit(uint256 assets,address receiver) returns (uint256)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256)",
  "function withdrawFromPool(uint256 lpAmount)",
];

const AUTOCOMPOUNDER_ABI = [
  "function stakedLpBalance() view returns (uint256)",
];

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Deployment manifest not found: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

async function waitForNextBlock(provider, fromBlock) {
  for (;;) {
    const block = await provider.getBlockNumber();
    if (block > fromBlock) return block;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function waitForSuccessfulReceipt(tx, label) {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} transaction did not confirm successfully.`);
  }
  return receipt;
}

async function waitForAllowance(asset, owner, spender, requiredAmount, decimals, symbol) {
  const deadline = Date.now() + 60_000;
  let lastAllowance = await asset.allowance(owner, spender);

  while (Date.now() < deadline) {
    if (lastAllowance >= requiredAmount) return lastAllowance;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    lastAllowance = await asset.allowance(owner, spender);
  }

  throw new Error(
    `Approval confirmed but allowance is still too low. allowance=${ethers.formatUnits(lastAllowance, decimals)} ${symbol}`
  );
}

async function main() {
  if (!CONFIRM) {
    console.log("Dry guard active. This script sends mainnet transactions.");
    console.log("Rerun with: SMOKE_CONFIRM=YES npm run smoke:yield");
    return;
  }

  const manifest = loadManifest();
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.SMOKE_PRIVATE_KEY;
  if (!privateKey) throw new Error("Set DEPLOYER_PRIVATE_KEY or SMOKE_PRIVATE_KEY.");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 8453, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(privateKey, provider);
  const keeperAddress = process.env.KEEPER_ADDRESS || manifest.yieldSenseKeeper;
  const keeper = new ethers.Contract(keeperAddress, KEEPER_ABI, wallet);
  const assetAddress = await keeper.asset();
  const asset = new ethers.Contract(assetAddress, ERC20_ABI, wallet);
  const [symbol, decimals] = await Promise.all([asset.symbol(), asset.decimals()]);
  const amount = ethers.parseUnits(AMOUNT, Number(decimals));

  console.log("\nYield vault smoke test");
  console.log("Wallet :", wallet.address);
  console.log("Keeper :", keeperAddress);
  console.log("Asset  :", `${symbol} ${assetAddress}`);
  console.log("Amount :", `${AMOUNT} ${symbol}`);

  const [walletBalance, maxDeposit, allowanceBefore, sharesBefore, assetsBefore, supplyBefore] = await Promise.all([
    asset.balanceOf(wallet.address),
    keeper.maxDeposit(wallet.address),
    asset.allowance(wallet.address, keeperAddress),
    keeper.balanceOf(wallet.address),
    keeper.totalAssets(),
    keeper.totalSupply(),
  ]);

  console.log("Before totalAssets:", ethers.formatUnits(assetsBefore, decimals), symbol);
  console.log("Before totalSupply:", ethers.formatUnits(supplyBefore, decimals), "ysUSDC");
  console.log("Before shares     :", ethers.formatUnits(sharesBefore, decimals), "ysUSDC");
  console.log("Before allowance  :", ethers.formatUnits(allowanceBefore, decimals), symbol);

  if (ONLY_REDEEM_EXISTING) {
    if (sharesBefore === 0n) throw new Error("SMOKE_ONLY_REDEEM=true but wallet has no vault shares.");
    if (UNWIND_BEFORE_REDEEM) {
      const autocompounderAddress = await keeper.autocompounder();
      const autocompounder = new ethers.Contract(autocompounderAddress, AUTOCOMPOUNDER_ABI, provider);
      const stakedLp = await autocompounder.stakedLpBalance();
      if (stakedLp > 0n) {
        console.log("Unwinding staked LP before redeem...");
        console.log("lpAmount raw:", stakedLp.toString());
        const unwindTx = await keeper.withdrawFromPool(stakedLp);
        console.log("unwind tx:", unwindTx.hash);
        await unwindTx.wait();
      } else {
        console.log("No staked LP to unwind before redeem.");
      }
    }
    console.log("Redeeming existing shares only...");
    const redeemTx = await keeper.redeem(sharesBefore, wallet.address, wallet.address);
    console.log("redeem tx:", redeemTx.hash);
    await waitForSuccessfulReceipt(redeemTx, "Redeem");
    console.log("\nExisting share redemption complete.");
    return;
  }

  if (walletBalance < amount) {
    throw new Error(`Insufficient ${symbol}. Have ${ethers.formatUnits(walletBalance, decimals)}, need ${AMOUNT}.`);
  }
  if (maxDeposit < amount) {
    throw new Error(`Vault maxDeposit too low. maxDeposit=${ethers.formatUnits(maxDeposit, decimals)} ${symbol}.`);
  }

  if (allowanceBefore < amount) {
    if (allowanceBefore > 0n) {
      console.log("Resetting existing allowance...");
      const resetTx = await asset.approve(keeperAddress, 0);
      console.log("reset tx:", resetTx.hash);
      const resetReceipt = await waitForSuccessfulReceipt(resetTx, "Allowance reset");
      await waitForNextBlock(provider, resetReceipt.blockNumber);
      await waitForAllowance(asset, wallet.address, keeperAddress, 0n, decimals, symbol);
    }

    console.log("Approving...");
    const approveTx = await asset.approve(keeperAddress, amount);
    console.log("approve tx:", approveTx.hash);
    const approveReceipt = await waitForSuccessfulReceipt(approveTx, "Approve");
    await waitForNextBlock(provider, approveReceipt.blockNumber);

    const allowanceAfter = await waitForAllowance(asset, wallet.address, keeperAddress, amount, decimals, symbol);
    console.log("Allowance ready:", ethers.formatUnits(allowanceAfter, decimals), symbol);
  } else {
    console.log("Allowance ready:", ethers.formatUnits(allowanceBefore, decimals), symbol);
  }

  console.log("Depositing...");
  const depositTx = await keeper.deposit(amount, wallet.address);
  console.log("deposit tx:", depositTx.hash);
  const depositReceipt = await waitForSuccessfulReceipt(depositTx, "Deposit");

  if (!REDEEM_AFTER_DEPOSIT) {
    console.log("SMOKE_REDEEM_AFTER_DEPOSIT=false, leaving smoke deposit in vault.");
    return;
  }

  console.log("Waiting for next block because same-block redemption is blocked...");
  await waitForNextBlock(provider, depositReceipt.blockNumber);

  const sharesAfterDeposit = await keeper.balanceOf(wallet.address);
  const mintedShares = sharesAfterDeposit - sharesBefore;
  console.log("Minted shares:", ethers.formatUnits(mintedShares, decimals), "ysUSDC");
  if (mintedShares === 0n) {
    throw new Error("Deposit confirmed but mintedShares is zero. Refusing to submit zero-share redeem.");
  }

  console.log("Redeeming minted shares...");
  const redeemTx = await keeper.redeem(mintedShares, wallet.address, wallet.address);
  console.log("redeem tx:", redeemTx.hash);
  const redeemReceipt = await waitForSuccessfulReceipt(redeemTx, "Redeem");
  await waitForNextBlock(provider, redeemReceipt.blockNumber);

  const [sharesAfterRedeem, assetsAfter, supplyAfter, maxWithdrawAfter] = await Promise.all([
    keeper.balanceOf(wallet.address),
    keeper.totalAssets(),
    keeper.totalSupply(),
    keeper.maxWithdraw(wallet.address),
  ]);

  console.log("After shares      :", ethers.formatUnits(sharesAfterRedeem, decimals), "ysUSDC");
  console.log("After maxWithdraw :", ethers.formatUnits(maxWithdrawAfter, decimals), symbol);
  console.log("After totalAssets :", ethers.formatUnits(assetsAfter, decimals), symbol);
  console.log("After totalSupply :", ethers.formatUnits(supplyAfter, decimals), "ysUSDC");
  console.log("\nYield vault smoke test complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
