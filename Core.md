# YieldSense — Core Documentation

> **Audience:** Developers joining the project for the first time.
> **Last updated:** April 2026

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Current Implementation Status](#2-current-implementation-status)
3. [Project Architecture](#3-project-architecture)
4. [Codebase Structure](#4-codebase-structure)
5. [Setup & Installation](#5-setup--installation)
6. [Environment Configuration](#6-environment-configuration)
7. [How the Project Works (Flow)](#7-how-the-project-works-flow)
8. [Known Issues / Limitations](#8-known-issues--limitations)
9. [Next Steps / Roadmap](#9-next-steps--roadmap)
10. [Additional Notes](#10-additional-notes)

---

## 1. Project Overview

### What is YieldSense?

YieldSense is an **automated DeFi yield harvesting and grid-trading system** designed to run inside [Acurast](https://acurast.com/) Trusted Execution Environments (TEEs). It monitors Aerodrome-style liquidity pools on the Base blockchain, computes real-time yield estimates from first-principles on-chain data, and autonomously triggers on-chain harvest or trade transactions only when they are provably profitable.

### Problem It Solves

Manual yield harvesting and compounding in DeFi is:
- **Economically inefficient** — gas costs often exceed accumulated rewards if triggered too early.
- **Insecure** — private keys used for automation are typically exposed to centralized infrastructure.
- **Opaque** — most bots rely on unverifiable off-chain APIs for APR data.

YieldSense solves all three by combining:
- A **first-principles yield engine** that computes APR directly from on-chain Swap logs and gauge state.
- A **TEE-based execution model** (Acurast) that keeps signing keys inside attested hardware enclaves.
- **Deterministic guardrails** (gas thresholds, confidence scores, efficiency multipliers) that prevent wasteful or risky transactions.

### Key Features

| Feature | Description |
|---|---|
| True Yield Engine | On-chain fee APR from Swap logs + gauge reward APR with EWMA smoothing |
| Hybrid APR Mode | Blends on-chain data with REST APIs (GeckoTerminal, DexScreener, DefiLlama) when confidence is low |
| Smart Profitability Check | Gas-aware decision engine with efficiency multiplier, cooldown, and circuit breaker |
| Acurast TEE Integration | Private key never leaves the attested enclave; two signing paths: hardware `_STD_` and local key |
| Grid Keeper | Second worker (`processor.ts`) monitors Uniswap V3 price, triggers grid-level trades via `executeTrade` |
| On-chain Vault | `YieldSenseKeeper.sol` — ERC-20 vault with TEE-authorized trade execution, timelocked admin, and nonce bitmap |
| Structured Telemetry | Every decision step emits JSON telemetry for observability |
| Adaptive Scheduling | Recommends next check interval based on APR regime and gas environment |

---

## 2. Current Implementation Status

### ✅ Fully Implemented

- **Yield Engine** (`src/yieldEngine/`) — fee APR from Swap logs, gauge reward APR, TWAB TVL, EWMA reward smoothing, composite confidence scoring, API fallback blending, forward APR projection stub.
- **Decision Engine** (`src/decisionEngine.ts`) — all profitability guardrails, circuit breaker, adaptive interval.
- **Harvest Worker** (`src/index.ts`) — full end-to-end orchestration: yield fetch → decision → signing → broadcast → state save.
- **Acurast Hardware Signing** (`src/acurastHardware.ts`) — `_STD_` secp256k1 signer, 64-byte/65-byte signature parsing, `fulfillEthereumHarvest`.
- **Software Signing Fallback** (`src/signature.ts`) — ECDSA sign/verify with `ACURAST_WORKER_KEY` for local testing.
- **Runtime State** (`src/runtimeState.ts`) — persistent JSON state (APR, failure streak, EWM checkpoint).
- **Legacy API Consensus** (`src/realtimeApr.ts`) — GeckoTerminal, DexScreener, DefiLlama with outlier filtering.
- **Grid Keeper Worker** (`src/processor.ts`) — price polling, grid trigger logic, stop-loss rules, `executeTrade` submission.
- **Smart Contract** (`contracts/YieldSenseKeeper.sol`) — deposit/withdraw/executeTrade vault with performance fee, nonce bitmap, 2-day timelock on admin addresses.
- **Testnet Environment** (`hardhat.config.cjs`) — Hardhat deployment scripts (`deployMockAndKeeper.cjs`), OpenZeppelin dependencies, and `MockERC20` contract for easy local/Sepolia testing.
- **Web3 Dashboard** (`frontend/`) — Fully designed, premium Next.js UI using Wagmi/Viem to interact with the Vault (deposit/withdraw/approve) and monitor worker telemetry.
- **Telemetry** (`src/telemetry.ts`) — structured JSON stdout events.
- **SS58 → EVM Address Utility** (`src/deriveAddress.ts`).
- **Test Suite** (`src/**/*.test.ts`) — unit tests for APR consensus, decision engine, signature, runtime state.
- **Pool Smoke Tests** (`src/poolSmoke.ts`) — live API smoke tests against multiple pool addresses.

### ⚠️ Partially Implemented

- **Forward APR Projection** (`src/yieldEngine/compute/forwardAerodrome.ts`) — stub exists and is wired up; accuracy depends on correct epoch data from gauge.
- **Grid Keeper Webpack Build** — `src/processor.ts` exists and is referenced in `acurast.config.ts` as `dist/processor.js`, but there is **no second Webpack entry point** in `webpack.config.js` to produce it. The file must be bundled separately.
- **Stop-loss Decryption** (`src/processor.ts`) — production TEE decryption path is a comment placeholder; the code assumes the TEE runtime pre-decrypts `STOP_LOSS_SECRET_JSON` before process start.

### ❌ Not Yet Implemented

- **Subgraph integration** — `DataSourceTag` includes `"subgraph:aerodrome"` but no subgraph indexer is implemented.
- **Chainlink / TWAP oracle** — similarly typed (`"oracle:twap"`, `"oracle:chainlink"`) but not implemented.
- **Multi-user vault accounting** — the contract supports multiple users but the worker only monitors a single `USER_ADDRESS` / `KEEPER_ADDRESS` pair.

---

## 3. Project Architecture

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                      Acurast TEE (attested)                     │
│                                                                 │
│  ┌─────────────────────┐      ┌──────────────────────────────┐  │
│  │  Harvest Worker     │      │  Grid Keeper Worker          │  │
│  │  (src/index.ts)     │      │  (src/processor.ts)          │  │
│  │                     │      │                              │  │
│  │  yieldEngine/       │      │  Uniswap V3 price feed       │  │
│  │  decisionEngine     │      │  grid trigger logic          │  │
│  │  signature          │      │  stop-loss rules             │  │
│  └────────┬────────────┘      └─────────────┬────────────────┘  │
│           │                                 │                   │
│           │  secp256k1 sign (_STD_)         │  secp256k1 sign   │
└───────────┼─────────────────────────────────┼───────────────────┘
            │                                 │
            ▼                                 ▼
   ┌─────────────────────────────────────────────────────────┐
   │               Base Blockchain (L2)                       │
   │                                                         │
   │   ┌─────────────────────────────────────────────────┐   │
   │   │             YieldSenseKeeper.sol                │   │
   │   │                                                 │   │
   │   │   deposit()      → user deposits ERC-20 asset  │   │
   │   │   executeTrade() → TEE-signed PnL update        │   │
   │   │   executeHarvest()→ TEE-signed harvest trigger  │   │
   │   │   withdraw()     → user withdraws + perf fee   │   │
   │   └─────────────────────────────────────────────────┘   │
   └─────────────────────────────────────────────────────────┘
            ▲                                 ▲
            │                                 │
   ┌────────┴──────────┐           ┌──────────┴────────┐
   │  Base RPC / Node  │           │  External APIs    │
   │  (execution RPC)  │           │  GeckoTerminal    │
   │                   │           │  DexScreener      │
   │  Base Mainnet RPC │           │  DefiLlama        │
   │  (data RPC, opt.) │           │  CoinGecko        │
   └───────────────────┘           └───────────────────┘
```

### Worker Separation

There are **two independent Acurast workers**:

| Worker | Entry Point | Acurast Project | Schedule | Purpose |
|---|---|---|---|---|
| Harvest Worker | `src/index.ts` → `dist/bundle.js` | `YieldSense` (acurast.json) | Every 10 min, 3 runs | Compute yield, decide profitability, call `executeHarvest` |
| Grid Keeper | `src/processor.ts` → `dist/processor.js` | `YieldSenseGridKeeper` (acurast.config.ts) | Every 60s, 100k runs | Poll price, trigger grid/stop-loss trades via `executeTrade` |

### Yield Estimation Pipeline

```
RPC Provider
    │
    ├── Swap event logs ──────► feeIndexer ──► feeApr
    ├── Pool reserves  ──────► liquidityIndexer ──► tvlUsdTwab
    ├── Gauge state    ──────► rewardIndexer ──► rewardApr (EWMA-smoothed)
    │
    └── Composite confidence score
            │
            ├── [if confidence < threshold] ──► API fallback blend
            │        GeckoTerminal + DexScreener + DefiLlama
            │
            └── Final: { feeApr, rewardApr, totalApr, estimatedApy, confidence, usable }
```

### Harvest Authorization Flow

```
Worker builds payloadHash = keccak256(keeperAddress, poolAddress, aprBps, rewardCents, timestamp)
    │
    ├── Hardware path: _STD_.signers.secp256k1.sign(hash) → (r, s, v)
    │       then: _STD_.chains.ethereum.fulfill(rpcUrl, keeperAddr, encodedArgs)
    │
    └── Software path: ethers.Wallet(ACURAST_WORKER_KEY).sign(hash) → (r, s, v)
            then: keeperContract.executeHarvest(payloadHash, r, s, v)

On-chain: ECDSA.recover(ethHash, signature) must equal acurastSigner
```

---

## 4. Codebase Structure

```
yieldsense/
├── contracts/
│   └── YieldSenseKeeper.sol          # On-chain vault + trade execution contract
│
├── src/
│   ├── index.ts                      # Harvest worker — main orchestration loop
│   ├── processor.ts                  # Grid keeper worker — price monitor + trade executor
│   ├── decisionEngine.ts             # Profitability & guardrail logic
│   ├── runtimeState.ts               # Persistent worker state (read/write JSON)
│   ├── signature.ts                  # Payload hash construction + ECDSA sign/verify
│   ├── acurastHardware.ts            # Acurast _STD_ interface, hardware signing, fulfill
│   ├── realtimeApr.ts                # Legacy API APR consensus (Gecko/Dex/Llama)
│   ├── telemetry.ts                  # Structured JSON stdout event emitter
│   ├── deriveAddress.ts              # SS58 → EVM address converter utility
│   ├── poolSmoke.ts                  # Live multi-pool smoke test script
│   ├── test-api.ts                   # Manual API endpoint test script
│   │
│   ├── yieldEngine/                  # First-principles yield estimation engine
│   │   ├── index.ts                  # Public re-exports
│   │   ├── types.ts                  # All shared TypeScript types and interfaces
│   │   ├── getRobustYieldEstimate.ts # Top-level orchestrator for yield pipeline
│   │   │
│   │   ├── compute/
│   │   │   ├── apy.ts                # APR → APY conversion (compound formula)
│   │   │   ├── feeApr.ts             # Annualized fee APR from USD fees + TVL + window
│   │   │   ├── rewardApr.ts          # EWMA-smoothed reward APR from gauge snapshot
│   │   │   └── forwardAerodrome.ts   # Forward APR projection stub (epoch-based)
│   │   │
│   │   ├── indexers/
│   │   │   ├── feeIndexer.ts         # Swap log scanner → total fee USD in window
│   │   │   ├── liquidityIndexer.ts   # Pool reserves TWAB → TVL USD
│   │   │   └── rewardIndexer.ts      # Gauge rewardRate + totalSupply snapshot
│   │   │
│   │   ├── ingestion/
│   │   │   ├── prices.ts             # Spot prices from reserves + divergence guard
│   │   │   ├── geckoPool.ts          # GeckoTerminal network id helper
│   │   │   └── rpc.ts                # Low-level RPC helpers
│   │   │
│   │   ├── robustness/
│   │   │   ├── confidence.ts         # Composite confidence + liquidity sensitivity penalty
│   │   │   └── smoothing.ts          # EWMA utilities
│   │   │
│   │   └── legacy/
│   │       └── apiFallback.ts        # API fallback blend + breakdown annotation
│   │
│   ├── *.test.ts                     # Unit tests (Node native test runner)
│
├── acurast.json                      # Acurast deployment config — Harvest Worker
├── acurast.config.ts                 # Acurast deployment config — Grid Keeper Worker
├── webpack.config.js                 # Webpack: src/index.ts → dist/bundle.js
├── tsconfig.json                     # TypeScript config (NodeNext, strict)
├── package.json                      # Dependencies and npm scripts
├── .yieldsense-state.json            # Runtime worker state (auto-generated, git-ignored)
├── README.md                         # Quick-start documentation
├── TESTCASES.md                      # Test case catalogue
└── Core.md                           # This file
```

### Key File Responsibilities

| File | Responsibility |
|---|---|
| `src/index.ts` | Main harvest loop: loads state, fetches ETH price + yield estimate + last harvest, evaluates decision, signs and broadcasts `executeHarvest`, saves state |
| `src/processor.ts` | Grid loop: reads price from Uniswap V3 `slot0`, applies grid + stop-loss rules, builds and submits `executeTrade` via Acurast fulfill |
| `src/decisionEngine.ts` | Pure function `evaluateDecision` — computes `netRewardUsd`, checks all guards, returns `shouldExecute` + reason |
| `src/yieldEngine/getRobustYieldEstimate.ts` | Orchestrates fee indexer, TVL indexer, gauge indexer, confidence, and API fallback into a single `RobustYieldEngineResult` |
| `src/acurastHardware.ts` | Wraps `_STD_` global: `getAcurastStd()`, `signHarvestPayloadWithAcurastHardware()`, `fulfillEthereumHarvest()` |
| `src/signature.ts` | `buildPayloadHash()` and `signHarvestPayload()` for local (non-TEE) signing |
| `src/runtimeState.ts` | `loadState()` / `saveState()` — persists `WorkerState` to a local JSON file between runs |
| `contracts/YieldSenseKeeper.sol` | ERC-20 vault: `deposit`, `executeTrade` (TEE-signed PnL), `withdraw` (with 10% performance fee), timelocked admin setters |

---

## 5. Setup & Installation

### Prerequisites

- **Node.js** v18+ (v20 recommended)
- **npm** v9+
- An Ethereum RPC endpoint (Base Sepolia for testing, Base Mainnet for production)
- An Acurast worker key (for harvest signing; can use a local EOA private key for dev)

### Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd yieldsense

# 2. Install dependencies
npm install
```

### Build

Compile TypeScript and bundle for Acurast deployment:

```bash
npm run build
```

This produces `dist/bundle.js` — the file that gets deployed to Acurast as the Harvest Worker.

> **Note:** There is currently no Webpack entry for `processor.ts`. To build the Grid Keeper separately, add a second entry or run:
> ```bash
> npx tsx src/processor.ts   # run directly with tsx (dev only)
> ```

### Run Locally (Harvest Worker)

```bash
# After building:
node dist/bundle.js

# Or run directly with tsx (no build needed, for development):
npx tsx src/index.ts
```

### Run Tests

```bash
# Deterministic unit tests
npm test

# Multi-pool live smoke tests (requires internet access)
npm run test:pools

# Custom pools
npx tsx src/poolSmoke.ts 0xPool1 0xPool2 0xPool3
```

### Derive Your Acurast Worker EVM Address

If you have an Acurast SS58 worker address and need the corresponding EVM address:

```bash
# Edit src/deriveAddress.ts to paste your SS58 address, then:
npx tsx src/deriveAddress.ts
```

### Run Frontend Dashboard

Once the frontend is implemented, you can run the local dashboard to visualize the worker state:

```bash
# Navigate to the frontend directory
cd frontend

# Install dependencies
npm install

# Run the Next.js development server
npm run dev
```
Access the dashboard at `http://localhost:3000`. The frontend uses Next.js API routes to automatically read and display the worker state from `.yieldsense-state.json`.

---

## 6. Environment Configuration

Create a `.env` file in the project root (it is git-ignored). Below is a complete annotated example.

### Example `.env`

```dotenv
# ── Execution RPC ─────────────────────────────────────────────────
# Blockchain node used for gas estimation, lastHarvest reads, and tx broadcast.
# MUST be the same network where KEEPER_ADDRESS is deployed.
RPC_URL=https://sepolia.base.org

# ── Data RPC (optional — hybrid mode) ────────────────────────────
# When set, the yield engine reads on-chain data from this RPC (e.g. mainnet)
# while all transactions are sent via RPC_URL (e.g. testnet).
# DATA_RPC_URL=https://mainnet.base.org
# MAINNET_DATA_RPC_URL=https://mainnet.base.org   # alias

# ── Chain ID override (optional) ─────────────────────────────────
# Force the yield engine to use a specific chain ID (e.g. 8453 = Base mainnet).
# YIELD_CHAIN_ID=8453

# ── Contract Addresses ────────────────────────────────────────────
KEEPER_ADDRESS=0x96Da70B750f8EB6Fc9Bf6CD1c5DFeB62B43C363D
POOL_ADDRESS=0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59

# ── Gauge / LP / Reward Token (optional — enables reward APR) ────
# GAUGE_ADDRESS=0x...
# LP_TOKEN_ADDRESS=0x...        # defaults to POOL_ADDRESS
# REWARD_TOKEN_ADDRESS=0x...    # override reward token for price lookup

# ── Strategy Parameters ────────────────────────────────────────────
STRATEGY_TVL_USD=10000          # Total strategy TVL in USD (used for reward estimation)
EFFICIENCY_MULTIPLIER=1.5       # Net reward must be > gasCost × this multiplier
POOL_FEE_RATE=0.003             # LP fee rate (0.3% = 0.003)
MIN_NET_REWARD_USD=1            # Minimum net reward in USD before executing
MAX_GAS_USD=30                  # Abort if gas cost exceeds this in USD
COOLDOWN_SEC=300                # Minimum seconds between harvest executions
MAX_API_FAILURE_STREAK=3        # Circuit breaker: skip after N consecutive API failures

# ── Yield Engine Parameters ────────────────────────────────────────
FEE_WINDOW_SEC=604800           # Lookback window for Swap log fee indexing (7 days)
FEE_MAX_BLOCKS=80000            # Max blocks scanned backward (RPC safety cap)
LOG_CHUNK_SIZE=3000             # Block chunks for eth_getLogs requests
REWARD_EWMA_HALF_LIFE_SEC=259200 # EWMA half-life for reward APR smoothing (3 days)
MIN_YIELD_CONFIDENCE=0.55       # Minimum confidence score to consider yield usable
MIN_APR_CONFIDENCE=0.55         # Minimum confidence for API fallback consensus
APR_FRESHNESS_WINDOW_SEC=1200   # Max age of API APR observations (seconds)
YIELD_FALLBACK_MODE=auto        # "off" | "api" | "auto" (blend API when RPC weak)
# YIELD_FORWARD_PROJECTION=true # Enable forward epoch APR projection (stub)
# POOL_FEE_BPS=30               # Override pool fee BPS (default: read from contract)
# STRATEGY_DELTA_USD=10000      # Strategy capital for liquidity sensitivity penalty
# APY_COMPOUNDS_PER_YEAR=365    # Compounding periods for APY calculation

# ── Signing (required for harvest execution) ──────────────────────
# On Acurast processors: the TEE injects ACURAST_WORKER_KEY automatically.
# For local development: set this to a funded EOA private key on the execution network.
ACURAST_WORKER_KEY=0xYOUR_PRIVATE_KEY_HERE

# ── Worker State ──────────────────────────────────────────────────
STATE_PATH=.yieldsense-state.json

# ── Force Test Flags (dev only) ───────────────────────────────────
# Bypass profitability checks and submit executeHarvest immediately.
# Only allowed on Base Sepolia unless FORCE_TEST_ALLOW_MAINNET=true.
# FORCE_TEST_HARVEST=true
# FORCE_TEST_ALLOW_MAINNET=false
# FORCE_TEST_APR_BPS=500        # Fixed APR for test payload (50 = 0.5%)
# FORCE_TEST_REWARD_CENTS=100   # Fixed net reward for test payload ($1.00)

# ── Grid Keeper (processor.ts only) ──────────────────────────────
# UNISWAP_POOL_ADDRESS=0x...    # Uniswap V3 pool for price feed
# USER_ADDRESS=0x...            # User address for grid trade attribution
# GRID_CONFIG_JSON=[{"id":"L1","referencePrice":2000,"triggerPercent":5,"allocationBps":1000}]
# STOP_LOSS_SECRET_JSON=...     # Encrypted stop-loss rules (TEE decrypts at runtime)
# STOP_LOSS_SIGNED_PAYLOAD=...  # Signed stop-loss rules (verified in-process)
```

### Variable Usage Map

| Variable | Used In |
|---|---|
| `RPC_URL` | `src/index.ts` (execution provider), `src/processor.ts` |
| `DATA_RPC_URL` / `MAINNET_DATA_RPC_URL` | `src/index.ts` (data provider for yield engine) |
| `YIELD_CHAIN_ID` | `src/index.ts` → `buildYieldRequest()` |
| `KEEPER_ADDRESS` | `src/index.ts`, `src/processor.ts` |
| `POOL_ADDRESS` | `src/index.ts` → `buildYieldRequest()` |
| `GAUGE_ADDRESS` | `src/index.ts` → `buildYieldRequest()` → `src/yieldEngine/getRobustYieldEstimate.ts` |
| `LP_TOKEN_ADDRESS` | `src/index.ts` → `buildYieldRequest()` |
| `REWARD_TOKEN_ADDRESS` | `src/index.ts` → `buildYieldRequest()` |
| `STRATEGY_TVL_USD` | `src/index.ts` → `evaluateDecision()` |
| `EFFICIENCY_MULTIPLIER` | `src/index.ts` → `evaluateDecision()` |
| `POOL_FEE_RATE` | `src/index.ts` → `evaluateDecision()` |
| `MIN_NET_REWARD_USD` | `src/index.ts` → `evaluateDecision()` |
| `MAX_GAS_USD` | `src/index.ts` → `evaluateDecision()` |
| `COOLDOWN_SEC` | `src/index.ts` → `evaluateDecision()` |
| `MAX_API_FAILURE_STREAK` | `src/index.ts` → `evaluateDecision()` |
| `FEE_WINDOW_SEC` | `src/index.ts` → `buildYieldRequest()` → `src/yieldEngine/indexers/feeIndexer.ts` |
| `FEE_MAX_BLOCKS` | Same chain as above |
| `LOG_CHUNK_SIZE` | `src/yieldEngine/indexers/feeIndexer.ts` |
| `REWARD_EWMA_HALF_LIFE_SEC` | `src/yieldEngine/compute/rewardApr.ts` |
| `MIN_YIELD_CONFIDENCE` | `src/index.ts` → `buildYieldRequest()` |
| `MIN_APR_CONFIDENCE` | `src/index.ts` → `buildYieldRequest()` |
| `APR_FRESHNESS_WINDOW_SEC` | `src/realtimeApr.ts`, `src/yieldEngine/legacy/apiFallback.ts` |
| `YIELD_FALLBACK_MODE` | `src/yieldEngine/getRobustYieldEstimate.ts` |
| `ACURAST_WORKER_KEY` | `src/index.ts` (software signing path) |
| `STATE_PATH` | `src/index.ts` → `loadState()` / `saveState()` |
| `UNISWAP_POOL_ADDRESS` | `src/processor.ts` |
| `USER_ADDRESS` | `src/processor.ts` |
| `GRID_CONFIG_JSON` | `src/processor.ts` → `parseJsonEnv()` |
| `STOP_LOSS_SECRET_JSON` | `src/processor.ts` → `decodeStopLossRules()` |
| `STOP_LOSS_SIGNED_PAYLOAD` | `src/processor.ts` → `decodeStopLossRules()` |

---

## 7. How the Project Works (Flow)

### Harvest Worker End-to-End Flow

```
1. STARTUP
   ├── Load .env (dotenv)
   ├── Create execution provider (RPC_URL)
   ├── Create data provider (DATA_RPC_URL if set, else same as execution)
   └── Verify KEEPER_ADDRESS has deployed code on execution chain

2. DATA COLLECTION (parallel)
   ├── getEthPrice()           → CoinGecko ETH/USD spot
   ├── getRobustYieldEstimate()→ on-chain fee + gauge APR (see yield pipeline below)
   ├── keeperRead.lastHarvest()→ timestamp of last on-chain harvest
   └── provider.getFeeData()   → current gas price

   YIELD PIPELINE (inside getRobustYieldEstimate):
   ├── getSpotPricesFromPool() → token0/token1 USD prices from reserves
   ├── twabTvlUsd()            → time-weighted average TVL from pool reserves
   ├── indexSwapFeesUsd()      → scan Swap logs → total fee USD in window
   ├── readGaugeSnapshot()     → gauge rewardRate, periodFinish, totalSupply (if GAUGE_ADDRESS)
   ├── smoothedRewardApr()     → EWMA-smoothed reward APR
   ├── compositeConfidence()   → coverage ratio × fee variance × oracle × gauge scores
   └── apiFallbackTotalApr()   → blend GeckoTerminal/DexScreener/DefiLlama if confidence low

3. YIELD USABILITY CHECK
   └── if aprConsensus.usable == false → save state, emit telemetry, EXIT

4. PROFITABILITY DECISION (evaluateDecision)
   ├── grossReward = tvlUsd × apr × elapsedSec / YEAR_SECONDS
   ├── netRewardUsd = grossReward × (1 - poolFeeRate)
   ├── thresholdUsd = gasCostUsd × efficiencyMultiplier
   │
   ├── Guards (checked in order):
   │   ├── circuit_breaker_api_failures  → apiFailureStreak >= maxFailureStreak
   │   ├── cooldown_active               → secondsSinceLastExecution < cooldownSec
   │   ├── gas_too_high                  → gasCostUsd > maxGasUsd
   │   ├── min_reward_not_met            → netRewardUsd < minNetRewardUsd
   │   └── profitability_threshold_not_met → netRewardUsd <= thresholdUsd
   │
   └── if shouldExecute == false → save state, emit telemetry, EXIT

5. SIGNING
   ├── Build payloadHash = keccak256(keeperAddress, poolAddress, aprBps, rewardCents, nowSec)
   │
   ├── Hardware path (Acurast TEE):
   │   ├── _STD_.signers.secp256k1.sign(payloadHash) → raw sig bytes
   │   └── parseSecp256k1SignOutput() → (r, s, v)
   │
   └── Software path (local dev):
       └── ethers.Wallet(ACURAST_WORKER_KEY).signingKey.sign(payloadHash) → (r, s, v)

6. BROADCAST
   ├── Hardware path: _STD_.chains.ethereum.fulfill(rpcUrl, keeperAddr, encodedArgs)
   └── Software path: keeperContract.executeHarvest(payloadHash, r, s, v)
       └── fallback: legacyKeeper.executeHarvest(r, s)  [older ABI compatibility]

7. CONFIRMATION
   ├── Wait for tx receipt
   ├── Save state (lastExecutionAt = now, reason = "executed")
   └── Emit harvest_confirmed telemetry
```

### Grid Keeper Flow (`src/processor.ts`)

```
1. Read env: RPC_URL, UNISWAP_POOL_ADDRESS, KEEPER_ADDRESS, USER_ADDRESS
2. Parse GRID_CONFIG_JSON → grid levels
3. Decode stop-loss rules (STOP_LOSS_SECRET_JSON or STOP_LOSS_SIGNED_PAYLOAD)
4. Filter active grids: remove grids below user's stop-loss price
5. fetchPoolPrice() → read slot0.sqrtPriceX96 → decode current price

For each active grid:
   6. shouldTrigger() → |currentPrice - referencePrice| / referencePrice >= triggerPercent
                        OR currentPrice <= stopLossPrice
   7. If triggered:
      ├── pnlDelta = (currentPrice >= referencePrice) ? +allocation : -allocation
      ├── nonce = Date.now() (bigint)
      ├── digest = keccak256(chainId, keeperAddress, user, pnlDelta, nonce)
      ├── signature = _STD_.signers.secp256k1.sign(digest)
      └── submitTradeViaAcurast() → _STD_.chains.ethereum.fulfill(executeTrade ABI)

8. Wait POLL_INTERVAL_MS (60s), repeat forever
```

### Smart Contract Authorization (`YieldSenseKeeper.sol`)

```
executeTrade(user, pnlDelta, nonce, signature):
   1. _useNonce(user, nonce)         → mark nonce in bitmap, revert if already used
   2. digest = keccak256(chainId, address(this), user, pnlDelta, nonce)  [computed on-chain]
   3. verifyAcurastSignature(digest, signature):
      ethHash = ECDSA.toEthSignedMessageHash(digest)
      ECDSA.recover(ethHash, signature) == acurastSigner
   4. if pnlDelta > 0: pull profit from yieldSource, add to user.balance
      if pnlDelta < 0: deduct from user.balance, send to counterparty
```

---

## 8. Known Issues / Limitations

### Contract Issues

1. **`Ownable` constructor call — will not compile as-is.**
   `YieldSenseKeeper.sol` calls `Ownable(msg.sender)` in its constructor, but only imports `Ownable2Step`. The fix is to either also import `Ownable` from OpenZeppelin or change the constructor call to `Ownable2Step(msg.sender)`.

2. **`@openzeppelin/contracts` not in `package.json`.**
   The contract imports OpenZeppelin but it is not listed as a dependency. You must add it via a Hardhat/Foundry project separately from the Node worker.

3. **`executeTrade` ABI mismatch between `processor.ts` and the contract.**
   `processor.ts` encodes `executeTrade(address, int256, uint256, bytes32, bytes)` — passing `digest` as a parameter. The deployed contract computes `digest` internally from `(chainId, address(this), user, pnlDelta, nonce)` and does not accept it as a parameter. The on-chain ABI is `executeTrade(address, int256, uint256, bytes)`. This will cause a call revert. The off-chain encoding or the contract signature must be reconciled.

4. **No `executeHarvest` function in `YieldSenseKeeper.sol`.**
   `src/index.ts` calls `executeHarvest(payloadHash, r, s, v)` on the keeper contract, but this function does not exist in the current `YieldSenseKeeper.sol` (which only has `executeTrade`, `deposit`, `withdraw`). There appear to be two separate contract versions — the harvest keeper referenced in `index.ts` and the trade/vault keeper in `contracts/`. These need to be unified or clearly separated.

### Worker Issues

5. **No Webpack entry for `processor.ts`.**
   `acurast.config.ts` expects `dist/processor.js` but `webpack.config.js` only bundles `src/index.ts` → `dist/bundle.js`. A second Webpack entry or a separate build script is needed.

6. **`Date.now()` as nonce in `processor.ts`.**
   Using millisecond timestamps as nonces is susceptible to collision if two executions happen within the same millisecond. Consider a monotonic counter or a cryptographic random nonce.

7. **`lastHarvest()` assumed on `YieldSenseKeeper`.**
   `src/index.ts` reads `keeperRead.lastHarvest()` via the keeper ABI. This function does not exist in the provided `YieldSenseKeeper.sol`. The code will throw a `BAD_DATA` error at runtime unless a different keeper contract (with `lastHarvest()`) is deployed at `KEEPER_ADDRESS`.

8. **Stop-loss decryption is a stub.**
   `processor.ts` comments that `STOP_LOSS_SECRET_JSON` "is decrypted by the TEE runtime before process start" — but no TEE decryption API call is actually made. In practice, if Acurast does not automatically decrypt environment variables, the raw encrypted blob will be passed to `JSON.parse()` and throw.

### General Limitations

9. **No contract deployment tooling.** There is no Hardhat or Foundry setup. The contract cannot be compiled or deployed without adding one.
10. **Single-user assumption in workers.** Both workers are configured for one `USER_ADDRESS` / one pool. Multi-user operation would require looping over users or a registry contract.
11. **ETH price fallback is hardcoded.** If CoinGecko is unreachable, ETH price defaults to `$3500`. This could cause incorrect gas cost estimates.
12. **No retry logic for RPC failures.** The worker exits with `process.exitCode = 1` on any unhandled error. Acurast will reschedule according to its job config, but transient RPC errors will count as full failures.

---

## 9. Next Steps / Roadmap

### Critical (Blockers)

- [ ] **Fix `YieldSenseKeeper.sol` compilation** — import `Ownable` or adjust to `Ownable2Step`, add `@openzeppelin/contracts` to a Foundry/Hardhat project.
- [ ] **Reconcile `executeHarvest` vs `executeTrade`** — decide whether one contract handles both harvest and trade flows, or split into two separate contracts. Update ABIs in both workers accordingly.
- [ ] **Add Webpack entry for `processor.ts`** — produce `dist/processor.js` as a second bundle target.

### High Priority

- [ ] **Contract deployment scripts** — write Hardhat or Foundry deployment scripts for `YieldSenseKeeper.sol` on Base Sepolia and Mainnet.
- [ ] **Contract test suite** — write Foundry/Hardhat tests covering: deposit, executeTrade (valid + replay + invalid sig), withdraw with fee, timelock flow.
- [ ] **Fix nonce generation in `processor.ts`** — replace `Date.now()` with a cryptographic random or per-user on-chain nonce read.
- [ ] **Reconcile `lastHarvest()` ABI** — either add `lastHarvest()` to the contract or remove the read from `index.ts` and use `state.lastExecutionAt` exclusively.

### Medium Priority

- [ ] **Add `dotenv` loading to `processor.ts`** — unlike `index.ts`, the grid keeper does not call `dotenv.config()` and will not pick up `.env` in local dev.
- [ ] **Multi-user grid keeper** — loop over a user registry or event-driven pattern rather than a single `USER_ADDRESS`.
- [ ] **Subgraph indexer** — implement `DataSourceTag` `"subgraph:aerodrome"` for faster historical fee data without scanning all Swap logs.
- [ ] **Chainlink / TWAP oracle** — implement oracle-based token pricing as a fallback when CoinGecko is unavailable.
- [ ] **Retry / backoff on RPC errors** — wrap `eth_getLogs` and `eth_call` with exponential backoff.
- [ ] **`.env.example` file** — add a committed example env file so new developers have a starting point.

### Low Priority / Enhancements

- [ ] **Dashboard / Frontend** — a simple UI showing current APR, last harvest, worker state, and telemetry.
- [ ] **Multi-pool harvest** — extend the harvest worker to manage multiple pools in a single run.
- [ ] **Hardened forward projection** — implement epoch-aware reward projection in `forwardAerodrome.ts` once Aerodrome epoch data is reliably available.
- [ ] **Telemetry sink** — pipe structured JSON telemetry to an external service (e.g. Datadog, custom webhook) instead of only stdout.

---

## 10. Additional Notes

### Two Separate Contract Contexts

The codebase contains references to **two conceptually distinct keeper contracts**:

- The **harvest keeper** — referenced in `src/index.ts` with `executeHarvest(payloadHash, r, s, v)` and `lastHarvest()`. This contract is not present in the `contracts/` directory.
- The **trade/vault keeper** — `contracts/YieldSenseKeeper.sol` with `executeTrade`, `deposit`, and `withdraw`. This is referenced in `src/processor.ts` and `acurast.config.ts`.

New developers should be aware that `YieldSenseKeeper.sol` is **not** the contract that `index.ts` calls.

### Hybrid RPC Mode

The project supports a split-RPC configuration: `DATA_RPC_URL` for yield calculations (e.g. Base Mainnet) and `RPC_URL` for transaction execution (e.g. Base Sepolia). This lets you test the full yield engine against live mainnet pool data while sending all transactions to a testnet keeper, avoiding mainnet gas costs during development.

### Acurast TEE vs Local Execution

The code has two execution paths that are selected at runtime:

- **TEE path** — `getAcurastStd()` returns the `_STD_` global (only available inside an Acurast processor). Uses hardware signing and the `fulfill` broadcast mechanism.
- **Local path** — `ACURAST_WORKER_KEY` env var is used with a standard `ethers.Wallet` for local development and CI testing.

If neither is available, the worker skips execution and emits a `missing_worker_key` telemetry event.

### Acurast Deployment

The project has two Acurast deployment configurations:

| Config File | Project Name | Bundle | Interval | Executions |
|---|---|---|---|---|
| `acurast.json` | `YieldSense` | `dist/bundle.js` | 10 min | 3 |
| `acurast.config.ts` | `YieldSenseGridKeeper` | `dist/processor.js` | 60 s | 100,000 |

The `acurast.json` uses `onlyAttestedDevices: false` (testnet / dev). The `acurast.config.ts` uses `onlyAttestedDevices: true` (production — enforce hardware attestation).

### Runtime State File

`.yieldsense-state.json` is written to `STATE_PATH` after each run and persists:
- `previousApr` — last computed total APR
- `apiFailureStreak` — consecutive runs without usable yield data
- `lastDecisionReason` — human-readable reason from the last decision
- `lastRunAt` / `lastExecutionAt` — Unix timestamps
- `suggestedNextCheckMs` — adaptive interval recommendation
- `yieldIndexerCheckpointBlock` — last block fully processed by the fee indexer
- `rewardAprEwm` — EWMA state for reward APR smoothing

This file should be treated as ephemeral operational data, not committed to source control (it is git-ignored).

### Dependencies

| Package | Purpose |
|---|---|
| `ethers` v6 | EVM provider, ABI encoding, signing, address recovery |
| `axios` | HTTP client for REST API calls (CoinGecko, GeckoTerminal, etc.) |
| `dotenv` | Load `.env` file in local development |
| `@polkadot/util` + `@polkadot/util-crypto` | SS58 address decoding for `deriveAddress.ts` |
| `tsx` (dev) | Run TypeScript directly without compilation |
| `webpack` + `ts-loader` (dev) | Bundle TypeScript for Acurast deployment |
| `typescript` (dev) | Type checking |
