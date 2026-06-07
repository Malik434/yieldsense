"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const MANIFEST_PATH =
  process.env.DEPLOYMENT_MANIFEST ||
  path.join(__dirname, "..", "deployments", "base-mainnet-complete.json");
const RPC_URL =
  process.env.BASE_MAINNET_RPC ||
  process.env.RPC_URL ||
  "https://mainnet.base.org";
const AMOUNT = process.env.SMOKE_USDC_AMOUNT || "1";
const CONFIRM = process.env.SMOKE_CONFIRM === "YES";
const WITHDRAW_AFTER_DEPOSIT =
  process.env.SMOKE_WITHDRAW_AFTER_DEPOSIT !== "false";
const EXECUTE_AERODROME = process.env.SMOKE_GRID_EXECUTE_AERODROME === "true";
const GRID_SIDE = (process.env.SMOKE_GRID_SIDE || "buy").toLowerCase();
const TEMP_REGISTER_EXECUTOR =
  process.env.SMOKE_GRID_TEMP_REGISTER_EXECUTOR === "YES";
const ENABLE_GAS_SUBSIDY = process.env.SMOKE_GRID_ENABLE_GAS_SUBSIDY === "YES";
const TRADE_AMOUNT = process.env.SMOKE_GRID_TRADE_USDC || "0.25";
const SLIPPAGE_BPS = BigInt(process.env.SMOKE_GRID_SLIPPAGE_BPS || "1500");
const AERO_USDC_LABEL = "AERO/USDC";
const EXISTING_STRATEGY_ID = process.env.SMOKE_GRID_STRATEGY_ID || "";
const RECORD_QUEUE = process.env.SMOKE_GRID_RECORD_QUEUE !== "false";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

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

const GRID_STRATEGY_MANAGER_ABI = [
  "function createStrategy(bytes32 pairId,bytes32 encryptedPayloadHash) returns (bytes32 strategyId)",
  "function allocateCapital(bytes32 strategyId,uint256 tradingAmountQuote,uint256 gasReserveQuote)",
  "function enableStrategy(bytes32 strategyId)",
  "function getStrategy(bytes32 strategyId) view returns (tuple(bytes32 id,address owner,bytes32 pairId,address baseToken,address quoteToken,uint256 allocatedQuote,uint256 quoteBalance,uint256 baseBalance,uint256 avgEntryPrice,int256 realizedPnlQuote,uint256 feesPaidQuote,uint256 gasReserveQuote,uint256 gasSpentQuote,uint256 maxGasCostQuotePerTrade,uint64 lastExecutionAt,int32 currentGridLevel,uint32 strategyVersion,bytes32 encryptedPayloadHash,uint8 status,uint64 createdAt,uint64 updatedAt))",
  "function getChainStateSnapshot(bytes32 strategyId) view returns (tuple(uint32 strategyVersion,int32 currentGridLevel,uint64 lastExecutionAt,uint256 quoteBalance,uint256 baseBalance))",
  "function testingGasSubsidyMode() view returns (bool)",
  "function setTestingGasSubsidyMode(bool enabled)",
  "event StrategyCreated(bytes32 indexed strategyId,address indexed owner,bytes32 indexed pairId,bytes32 encryptedPayloadHash)",
];

const GRID_EXECUTION_ROUTER_ABI = [
  "function executeAerodromeBuy(bytes32 strategyId,bytes32 pairId,bytes32 executionId,address dexRouter,tuple(uint32 strategyVersion,int32 currentGridLevel,uint64 lastExecutionAt,uint256 quoteBalance,uint256 baseBalance) snapshot,uint256 quoteAmount,uint256 minBaseOut,uint256 avgEntryPrice,uint256 dexFeeQuote,uint256 gasCostQuote,int32 nextGridLevel,uint256 deadline,tuple(address from,address to,bool stable,address factory)[] routes)",
  "function executeAerodromeSell(bytes32 strategyId,bytes32 pairId,bytes32 executionId,address dexRouter,tuple(uint32 strategyVersion,int32 currentGridLevel,uint64 lastExecutionAt,uint256 quoteBalance,uint256 baseBalance) snapshot,uint256 baseAmount,uint256 minQuoteOut,int256 realizedPnlQuote,uint256 dexFeeQuote,uint256 gasCostQuote,int32 nextGridLevel,uint256 deadline,tuple(address from,address to,bool stable,address factory)[] routes)",
];

const EXECUTOR_REGISTRY_ABI = [
  "function GRID_EXECUTOR() view returns (bytes32)",
  "function isAuthorized(address processor,bytes32 role) view returns (bool)",
  "function registerProcessor(address processor,bytes32 role,bytes32 deploymentHash,bytes32 codeHash)",
  "function revokeProcessor(address processor,bytes32 role)",
];

const AERODROME_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn,tuple(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
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

async function waitForAllowance(
  asset,
  owner,
  spender,
  requiredAmount,
  decimals,
  symbol,
) {
  const deadline = Date.now() + 60_000;
  let lastAllowance = await asset.allowance(owner, spender);

  while (Date.now() < deadline) {
    if (lastAllowance >= requiredAmount) return lastAllowance;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    lastAllowance = await asset.allowance(owner, spender);
  }

  throw new Error(
    `Approval confirmed but allowance is still too low. allowance=${ethers.formatUnits(lastAllowance, decimals)} ${symbol}`,
  );
}

function findGridPair(manifest, label) {
  const pair = manifest.gridPairs?.find((item) => item.label === label);
  if (!pair)
    throw new Error(`Grid pair ${label} not found in deployment manifest.`);
  return pair;
}

function extractStrategyId(receipt, managerInterface) {
  for (const log of receipt.logs) {
    try {
      const parsed = managerInterface.parseLog(log);
      if (parsed?.name === "StrategyCreated") {
        return parsed.args.strategyId;
      }
    } catch {
      // Ignore logs from other contracts in the same transaction.
    }
  }
  throw new Error("StrategyCreated event not found in createStrategy receipt.");
}

function minOutWithSlippage(quotedOut) {
  const clampedBps = SLIPPAGE_BPS > 10_000n ? 10_000n : SLIPPAGE_BPS;
  return (quotedOut * (10_000n - clampedBps)) / 10_000n;
}

function toSnapshotTuple(snapshot) {
  return [
    Number(snapshot.strategyVersion),
    Number(snapshot.currentGridLevel),
    Number(snapshot.lastExecutionAt),
    BigInt(snapshot.quoteBalance),
    BigInt(snapshot.baseBalance),
  ];
}

function toSnapshotJson(snapshot) {
  return {
    strategyVersion: Number(snapshot.strategyVersion),
    currentGridLevel: Number(snapshot.currentGridLevel),
    lastExecutionAt: String(snapshot.lastExecutionAt),
    quoteBalance: String(snapshot.quoteBalance),
    baseBalance: String(snapshot.baseBalance),
  };
}

async function recordExecutionJob({ strategyId, pairId, side, gridLevel, snapshot, txHash, gasUsed }) {
  if (!RECORD_QUEUE) return;
  try {
    const response = await fetch(`${FRONTEND_URL}/api/grid/execution-queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        strategyId,
        pairId,
        side,
        gridLevel,
        idempotencyKey: ["smoke", strategyId, side, txHash].join(":"),
        chainStateSnapshot: toSnapshotJson(snapshot),
        status: "confirmed",
        txHash,
        gasUsed: gasUsed ? String(gasUsed) : undefined,
      }),
    });
    if (!response.ok) {
      console.log("WARN: queue record failed:", response.status, await response.text());
      return;
    }
    console.log("Execution queue recorded.");
  } catch (error) {
    console.log("WARN: queue record failed:", error instanceof Error ? error.message : String(error));
  }
}

async function ensureTemporaryGridExecutor(registry, walletAddress) {
  const role = await registry.GRID_EXECUTOR();
  const alreadyAuthorized = await registry.isAuthorized(walletAddress, role);
  if (alreadyAuthorized) return { role, registeredByScript: false };
  if (!TEMP_REGISTER_EXECUTOR) {
    throw new Error(
      "Wallet is not GRID_EXECUTOR. Set SMOKE_GRID_TEMP_REGISTER_EXECUTOR=YES for live smoke execution.",
    );
  }

  console.log("Temporarily registering wallet as GRID_EXECUTOR...");
  const tx = await registry.registerProcessor(
    walletAddress,
    role,
    ethers.ZeroHash,
    ethers.ZeroHash,
  );
  console.log("register tx:", tx.hash);
  await waitForSuccessfulReceipt(tx, "GRID_EXECUTOR registration");
  return { role, registeredByScript: true };
}

async function ensureTestingGasSubsidy(manager) {
  const previousMode = await manager.testingGasSubsidyMode();
  if (previousMode) return { previousMode, changedByScript: false };
  if (!ENABLE_GAS_SUBSIDY) {
    throw new Error(
      "Grid testing gas subsidy mode is disabled. Set SMOKE_GRID_ENABLE_GAS_SUBSIDY=YES for live smoke execution.",
    );
  }

  console.log("Temporarily enabling grid testing gas subsidy mode...");
  const tx = await manager.setTestingGasSubsidyMode(true);
  console.log("gas subsidy tx:", tx.hash);
  await waitForSuccessfulReceipt(tx, "Testing gas subsidy enable");
  return { previousMode, changedByScript: true };
}

async function main() {
  if (!CONFIRM) {
    console.log("Dry guard active. This script sends mainnet transactions.");
    console.log("Rerun with: SMOKE_CONFIRM=YES npm run smoke:grid");
    return;
  }

  const manifest = loadManifest();
  const privateKey =
    process.env.DEPLOYER_PRIVATE_KEY || process.env.SMOKE_PRIVATE_KEY;
  if (!privateKey)
    throw new Error("Set DEPLOYER_PRIVATE_KEY or SMOKE_PRIVATE_KEY.");

  const provider = new ethers.JsonRpcProvider(RPC_URL, 8453, {
    batchMaxCount: 1,
  });
  const wallet = new ethers.Wallet(privateKey, provider);
  const gridVaultAddress = process.env.GRID_VAULT_ADDRESS || manifest.gridVault;
  const assetAddress = process.env.GRID_SMOKE_TOKEN_ADDRESS || manifest.usdc;
  const managerAddress =
    process.env.GRID_STRATEGY_MANAGER_ADDRESS || manifest.gridStrategyManager;
  const executionRouterAddress =
    process.env.GRID_EXECUTION_ROUTER_ADDRESS || manifest.gridExecutionRouter;
  const executorRegistryAddress =
    process.env.EXECUTOR_REGISTRY_ADDRESS || manifest.executorRegistry;
  const gridVault = new ethers.Contract(
    gridVaultAddress,
    GRID_VAULT_ABI,
    wallet,
  );
  const strategyManager = new ethers.Contract(
    managerAddress,
    GRID_STRATEGY_MANAGER_ABI,
    wallet,
  );
  const executionRouter = new ethers.Contract(
    executionRouterAddress,
    GRID_EXECUTION_ROUTER_ABI,
    wallet,
  );
  const executorRegistry = new ethers.Contract(
    executorRegistryAddress,
    EXECUTOR_REGISTRY_ABI,
    wallet,
  );
  const asset = new ethers.Contract(assetAddress, ERC20_ABI, wallet);
  const [symbol, decimals] = await Promise.all([
    asset.symbol(),
    asset.decimals(),
  ]);
  const amount = ethers.parseUnits(AMOUNT, Number(decimals));

  console.log("\nGrid vault smoke test");
  console.log("Wallet    :", wallet.address);
  console.log("GridVault :", gridVaultAddress);
  console.log("Manager   :", managerAddress);
  console.log("Router    :", executionRouterAddress);
  console.log("Token     :", `${symbol} ${assetAddress}`);
  console.log("Amount    :", `${AMOUNT} ${symbol}`);
  if (EXECUTE_AERODROME) {
    console.log("Live swap :", "enabled");
    console.log("Side      :", GRID_SIDE);
    console.log("Trade size:", `${TRADE_AMOUNT} ${symbol}`);
    if (EXISTING_STRATEGY_ID) console.log("Resume id :", EXISTING_STRATEGY_ID);
  }

  const [supported, paused, walletBalance, allowanceBefore, availableBefore] =
    await Promise.all([
      gridVault.supportedToken(assetAddress),
      gridVault.pausedAll(),
      asset.balanceOf(wallet.address),
      asset.allowance(wallet.address, gridVaultAddress),
      gridVault.availableBalance(wallet.address, assetAddress),
    ]);

  if (!supported) throw new Error(`${symbol} is not supported by GridVault.`);
  if (paused) throw new Error("GridVault is paused.");
  const skipInitialDeposit = EXECUTE_AERODROME && Boolean(EXISTING_STRATEGY_ID);
  if (!skipInitialDeposit && walletBalance < amount) {
    throw new Error(
      `Insufficient ${symbol}. Have ${ethers.formatUnits(walletBalance, decimals)}, need ${AMOUNT}.`,
    );
  }

  console.log(
    "Before available:",
    ethers.formatUnits(availableBefore, decimals),
    symbol,
  );
  console.log(
    "Before allowance :",
    ethers.formatUnits(allowanceBefore, decimals),
    symbol,
  );

  if (skipInitialDeposit) {
    console.log("Skipping deposit because SMOKE_GRID_STRATEGY_ID is set.");
  } else if (allowanceBefore < amount) {
    if (allowanceBefore > 0n) {
      console.log("Resetting existing allowance...");
      const resetTx = await asset.approve(gridVaultAddress, 0);
      console.log("reset tx:", resetTx.hash);
      const resetReceipt = await waitForSuccessfulReceipt(
        resetTx,
        "Allowance reset",
      );
      await waitForNextBlock(provider, resetReceipt.blockNumber);
      await waitForAllowance(
        asset,
        wallet.address,
        gridVaultAddress,
        0n,
        decimals,
        symbol,
      );
    }

    console.log("Approving...");
    const approveTx = await asset.approve(gridVaultAddress, amount);
    console.log("approve tx:", approveTx.hash);
    const approveReceipt = await waitForSuccessfulReceipt(approveTx, "Approve");
    await waitForNextBlock(provider, approveReceipt.blockNumber);
    const allowanceAfter = await waitForAllowance(
      asset,
      wallet.address,
      gridVaultAddress,
      amount,
      decimals,
      symbol,
    );
    console.log(
      "Allowance ready :",
      ethers.formatUnits(allowanceAfter, decimals),
      symbol,
    );
  } else {
    console.log(
      "Allowance ready :",
      ethers.formatUnits(allowanceBefore, decimals),
      symbol,
    );
  }

  if (!skipInitialDeposit) {
    console.log("Depositing...");
    const depositTx = await gridVault.deposit(assetAddress, amount);
    console.log("deposit tx:", depositTx.hash);
    const depositReceipt = await waitForSuccessfulReceipt(depositTx, "Deposit");
    await waitForNextBlock(provider, depositReceipt.blockNumber);
  }

  const availableAfterDeposit = await gridVault.availableBalance(
    wallet.address,
    assetAddress,
  );
  console.log(
    skipInitialDeposit ? "Current available:" : "After deposit available:",
    ethers.formatUnits(availableAfterDeposit, decimals),
    symbol,
  );

  if (EXECUTE_AERODROME) {
    if (GRID_SIDE !== "buy" && GRID_SIDE !== "sell") {
      throw new Error("SMOKE_GRID_SIDE must be buy or sell.");
    }
    const pair = findGridPair(manifest, AERO_USDC_LABEL);
    const tradeAmount = ethers.parseUnits(TRADE_AMOUNT, Number(decimals));
    if (!EXISTING_STRATEGY_ID && availableAfterDeposit < tradeAmount) {
      throw new Error(
        `Not enough GridVault available balance for trade. available=${ethers.formatUnits(availableAfterDeposit, decimals)} ${symbol}`,
      );
    }

    let registryState = null;
    let gasModeState = null;
    try {
      registryState = await ensureTemporaryGridExecutor(
        executorRegistry,
        wallet.address,
      );
      gasModeState = await ensureTestingGasSubsidy(strategyManager);
      const baseToken = ethers.getAddress(pair.baseToken);
      const quoteToken = ethers.getAddress(pair.quoteToken);
      const dexRouter = new ethers.Contract(
        manifest.router,
        AERODROME_ROUTER_ABI,
        provider,
      );

      let strategyId = EXISTING_STRATEGY_ID;
      if (!strategyId) {
        const strategyPayload = {
          pair: AERO_USDC_LABEL,
          lowerPrice: "smoke",
          upperPrice: "smoke",
          gridCount: 2,
          tradeSizeQuote: TRADE_AMOUNT,
          executionIntervalSec: 60,
          mode: "smoke-live-buy",
        };
        const payloadHash = ethers.keccak256(
          ethers.toUtf8Bytes(JSON.stringify(strategyPayload)),
        );

        console.log("Creating smoke grid strategy...");
        const createTx = await strategyManager.createStrategy(
          pair.pairId,
          payloadHash,
        );
        console.log("create strategy tx:", createTx.hash);
        const createReceipt = await waitForSuccessfulReceipt(
          createTx,
          "Create strategy",
        );
        await waitForNextBlock(provider, createReceipt.blockNumber);
        strategyId = extractStrategyId(
          createReceipt,
          strategyManager.interface,
        );
        console.log("strategyId:", strategyId);

        console.log("Allocating strategy capital...");
        const allocateTx = await strategyManager.allocateCapital(
          strategyId,
          tradeAmount,
          0,
        );
        console.log("allocate tx:", allocateTx.hash);
        const allocateReceipt = await waitForSuccessfulReceipt(
          allocateTx,
          "Allocate capital",
        );
        await waitForNextBlock(provider, allocateReceipt.blockNumber);

        console.log("Enabling strategy...");
        const enableTx = await strategyManager.enableStrategy(strategyId);
        console.log("enable tx:", enableTx.hash);
        const enableReceipt = await waitForSuccessfulReceipt(
          enableTx,
          "Enable strategy",
        );
        await waitForNextBlock(provider, enableReceipt.blockNumber);
      } else {
        console.log("Using existing strategy:", strategyId);
      }

      const snapshot = await strategyManager.getChainStateSnapshot(strategyId);
      const executionId = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "address", "uint256"],
          [strategyId, wallet.address, Date.now()],
        ),
      );
      const deadline = Math.floor(Date.now() / 1000) + 180;

      let executeTx;
      let executeReceipt;
      let nextGridLevel;

      if (GRID_SIDE === "buy") {
        const route = [
          [quoteToken, baseToken, false, ethers.getAddress(manifest.factory)],
        ];
        const quotedAmounts = await dexRouter.getAmountsOut(tradeAmount, route);
        const quotedBaseOut = quotedAmounts[quotedAmounts.length - 1];
        const minBaseOut = minOutWithSlippage(quotedBaseOut);
        if (minBaseOut === 0n) {
          throw new Error(
            "Quoted Aerodrome output is zero; refusing live grid smoke execution.",
          );
        }
        const avgEntryPrice = (tradeAmount * 1_000_000n) / quotedBaseOut;
        nextGridLevel = Number(snapshot.currentGridLevel) + 1;

        console.log("Executing Aerodrome grid buy...");
        console.log("quoted base out:", quotedBaseOut.toString());
        console.log("min base out   :", minBaseOut.toString());
        executeTx = await executionRouter.executeAerodromeBuy(
          strategyId,
          pair.pairId,
          executionId,
          manifest.router,
          toSnapshotTuple(snapshot),
          tradeAmount,
          minBaseOut,
          avgEntryPrice,
          0,
          0,
          nextGridLevel,
          deadline,
          route,
          { gasLimit: 1_500_000 },
        );
        console.log("execute buy tx:", executeTx.hash);
        executeReceipt = await waitForSuccessfulReceipt(
          executeTx,
          "Aerodrome grid buy",
        );
      } else {
        const strategyBeforeSell = await strategyManager.getStrategy(strategyId);
        const baseAmount = BigInt(strategyBeforeSell.baseBalance);
        if (baseAmount === 0n) {
          throw new Error("Strategy has no base inventory to sell.");
        }

        const route = [
          [baseToken, quoteToken, false, ethers.getAddress(manifest.factory)],
        ];
        const quotedAmounts = await dexRouter.getAmountsOut(baseAmount, route);
        const quotedQuoteOut = quotedAmounts[quotedAmounts.length - 1];
        const minQuoteOut = minOutWithSlippage(quotedQuoteOut);
        if (minQuoteOut === 0n) {
          throw new Error(
            "Quoted Aerodrome sell output is zero; refusing live grid smoke execution.",
          );
        }
        nextGridLevel = Math.max(Number(snapshot.currentGridLevel) - 1, 0);

        console.log("Executing Aerodrome grid sell...");
        console.log("base amount     :", baseAmount.toString());
        console.log("quoted quote out:", quotedQuoteOut.toString());
        console.log("min quote out   :", minQuoteOut.toString());
        executeTx = await executionRouter.executeAerodromeSell(
          strategyId,
          pair.pairId,
          executionId,
          manifest.router,
          toSnapshotTuple(snapshot),
          baseAmount,
          minQuoteOut,
          0,
          0,
          0,
          nextGridLevel,
          deadline,
          route,
          { gasLimit: 1_500_000 },
        );
        console.log("execute sell tx:", executeTx.hash);
        executeReceipt = await waitForSuccessfulReceipt(
          executeTx,
          "Aerodrome grid sell",
        );
      }
      await waitForNextBlock(provider, executeReceipt.blockNumber);
      await recordExecutionJob({
        strategyId,
        pairId: pair.pairId,
        side: GRID_SIDE,
        gridLevel: nextGridLevel,
        snapshot,
        txHash: executeTx.hash,
        gasUsed: executeReceipt.gasUsed,
      });

      const strategy = await strategyManager.getStrategy(strategyId);
      console.log(
        `After ${GRID_SIDE} quoteBalance:`,
        ethers.formatUnits(strategy.quoteBalance, decimals),
        symbol,
      );
      console.log(
        `After ${GRID_SIDE} baseBalance :`,
        strategy.baseBalance.toString(),
        "raw AERO",
      );
      console.log(
        `After ${GRID_SIDE} gridLevel   :`,
        strategy.currentGridLevel.toString(),
      );

      console.log("\nLive Aerodrome grid smoke complete.");
      console.log(
        "NOTE: strategy capital remains locked because the deployed manager has no close/release function yet.",
      );
    } finally {
      if (gasModeState?.changedByScript) {
        console.log("Restoring grid testing gas subsidy mode...");
        const restoreGasTx = await strategyManager.setTestingGasSubsidyMode(
          gasModeState.previousMode,
        );
        console.log("restore gas tx:", restoreGasTx.hash);
        await waitForSuccessfulReceipt(
          restoreGasTx,
          "Testing gas subsidy restore",
        );
      }
      if (
        registryState?.registeredByScript &&
        process.env.SMOKE_GRID_REVOKE_TEMP_EXECUTOR !== "false"
      ) {
        console.log("Revoking temporary GRID_EXECUTOR authorization...");
        const revokeTx = await executorRegistry.revokeProcessor(
          wallet.address,
          registryState.role,
        );
        console.log("revoke tx:", revokeTx.hash);
        await waitForSuccessfulReceipt(revokeTx, "GRID_EXECUTOR revocation");
      }
    }
    return;
  }

  if (!WITHDRAW_AFTER_DEPOSIT) {
    console.log(
      "SMOKE_WITHDRAW_AFTER_DEPOSIT=false, leaving smoke deposit in GridVault.",
    );
    return;
  }

  console.log("Withdrawing smoke deposit...");
  const withdrawTx = await gridVault.withdraw(assetAddress, amount);
  console.log("withdraw tx:", withdrawTx.hash);
  const withdrawReceipt = await waitForSuccessfulReceipt(
    withdrawTx,
    "Withdraw",
  );
  await waitForNextBlock(provider, withdrawReceipt.blockNumber);

  const availableAfterWithdraw = await gridVault.availableBalance(
    wallet.address,
    assetAddress,
  );
  console.log(
    "After withdraw available:",
    ethers.formatUnits(availableAfterWithdraw, decimals),
    symbol,
  );
  console.log("\nGrid vault smoke test complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
