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
const WITHDRAW_AFTER_DEPOSIT = process.env.SMOKE_WITHDRAW_AFTER_DEPOSIT !== "false";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];

const GRID_VAULT_ABI = [
  "function availableBalance(address user,address token) view returns (uint256)",
  "function supportedToken(address token) view returns (bool)",
  "function pausedAll() view returns (bool)",
  "function deposit(address token,uint256 amount)",
  "function withdraw(address token,uint256 amount)",
];

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Deployment manifest not found: ${MANIFEST_PATH}`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

async function main() {
  if (!CONFIRM) {
    console.log("Dry guard active. This script sends mainnet transactions.");
    console.log("Rerun with: SMOKE_CONFIRM=YES npm run smoke:grid");
    return;
  }

  const manifest = loadManifest();
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.SMOKE_PRIVATE_KEY;
  if (!privateKey) throw new Error("Set DEPLOYER_PRIVATE_KEY or SMOKE_PRIVATE_KEY.");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 8453, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(privateKey, provider);
  const gridVaultAddress = process.env.GRID_VAULT_ADDRESS || manifest.gridVault;
  const assetAddress = process.env.GRID_SMOKE_TOKEN_ADDRESS || manifest.usdc;
  const gridVault = new ethers.Contract(gridVaultAddress, GRID_VAULT_ABI, wallet);
  const asset = new ethers.Contract(assetAddress, ERC20_ABI, wallet);
  const [symbol, decimals] = await Promise.all([asset.symbol(), asset.decimals()]);
  const amount = ethers.parseUnits(AMOUNT, Number(decimals));

  console.log("\nGrid vault smoke test");
  console.log("Wallet    :", wallet.address);
  console.log("GridVault :", gridVaultAddress);
  console.log("Token     :", `${symbol} ${assetAddress}`);
  console.log("Amount    :", `${AMOUNT} ${symbol}`);

  const [supported, paused, walletBalance, allowanceBefore, availableBefore] = await Promise.all([
    gridVault.supportedToken(assetAddress),
    gridVault.pausedAll(),
    asset.balanceOf(wallet.address),
    asset.allowance(wallet.address, gridVaultAddress),
    gridVault.availableBalance(wallet.address, assetAddress),
  ]);

  if (!supported) throw new Error(`${symbol} is not supported by GridVault.`);
  if (paused) throw new Error("GridVault is paused.");
  if (walletBalance < amount) {
    throw new Error(`Insufficient ${symbol}. Have ${ethers.formatUnits(walletBalance, decimals)}, need ${AMOUNT}.`);
  }

  console.log("Before available:", ethers.formatUnits(availableBefore, decimals), symbol);

  if (allowanceBefore < amount) {
    console.log("Approving...");
    const approveTx = await asset.approve(gridVaultAddress, amount);
    console.log("approve tx:", approveTx.hash);
    await approveTx.wait();
  }

  console.log("Depositing...");
  const depositTx = await gridVault.deposit(assetAddress, amount);
  console.log("deposit tx:", depositTx.hash);
  await depositTx.wait();

  const availableAfterDeposit = await gridVault.availableBalance(wallet.address, assetAddress);
  console.log("After deposit available:", ethers.formatUnits(availableAfterDeposit, decimals), symbol);

  if (!WITHDRAW_AFTER_DEPOSIT) {
    console.log("SMOKE_WITHDRAW_AFTER_DEPOSIT=false, leaving smoke deposit in GridVault.");
    return;
  }

  console.log("Withdrawing smoke deposit...");
  const withdrawTx = await gridVault.withdraw(assetAddress, amount);
  console.log("withdraw tx:", withdrawTx.hash);
  await withdrawTx.wait();

  const availableAfterWithdraw = await gridVault.availableBalance(wallet.address, assetAddress);
  console.log("After withdraw available:", ethers.formatUnits(availableAfterWithdraw, decimals), symbol);
  console.log("\nGrid vault smoke test complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
