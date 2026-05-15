# YieldSense — Core Documentation

> **Audience:** Developers joining the project for the first time.
> **Last updated:** May 2026

---

### 🚀 May 2026 Architecture Updates
* **One-Shot Task Model:** The Acurast processor has been refactored from a loop-based long-running task to a one-shot execution model. This prevents "boot storms," aligns with serverless scheduling, and ensures clean exits within Acurast's 1-hour interval.
* **RPC Failover Transport:** A robust failover layer in `src/rpcProvider.ts` automatically rotates between multiple RPC endpoints (e.g., Infura, Alchemy, and public backups) to bypass 429 rate limits and ensure execution stability.
* **On-Chain Event Indexing:** The frontend has migrated from telemetry-based execution history to direct on-chain event indexing using `viem`. This ensures a tamper-proof source of truth for the "Guardian Ledger."
* **Base Mainnet Transition:** The protocol is now fully production-ready on Base Mainnet, with multisig-governed processor attestation and hardened gas-aware guardrails.

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

---

## 2. Current Implementation Status

### ✅ Fully Implemented

- **Yield Engine** (`src/yieldEngine/`) — fee APR from Swap logs, gauge reward APR, Moonwell lending market APY tracking, TWAB TVL, EWMA reward smoothing, composite confidence scoring, API fallback blending.
- **RPC Failover** (`src/rpcProvider.ts`) — custom Ethers provider with automated rotation across multiple endpoints (detects 429, 500, 503, and timeouts).
- **One-Shot Processor** (`src/index.ts`) — discrete execution lifecycle: boot → index → decide → execute → exit.
- **Decision Engine** (`src/decisionEngine.ts`) — gas-aware profitability guardrails, circuit breaker, and cooldowns.
- **Acurast Hardware Signing** (`src/acurastHardware.ts`) — `_STD_` secp256k1 signer and `fulfill` broadcast mechanism.
- **Smart Contract** (`contracts/YieldSenseKeeper.sol`) — Unified vault with P-256 hardware attestation gate (RIP-7212), multisig ownership, and performance fee logic.
- **Web3 Dashboard** (`frontend/`) — Premium Next.js UI with **On-Chain Event Indexing** for historical transaction tracking and real-time telemetry streaming.
- **Multisig Governance** — Integration with Gnosis Safe for administrative actions and processor attestation.

### ⚠️ Partially Implemented

- **Forward APR Projection** (`src/yieldEngine/compute/forwardAerodrome.ts`) — stub exists; requires reliable epoch data from Aerodrome gauges.

---

## 3. Project Architecture

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                      Acurast TEE (One-Shot)                     │
│                                                                 │
│  ┌─────────────────────┐      ┌──────────────────────────────┐  │
│  │  Harvest Worker     │      │  Grid Keeper Worker          │  │
│  │  (src/index.ts)     │      │  (src/processor.ts)          │  │
│  │                     │      │                              │  │
│  │  RPC Failover Layer ◄──────┼─── Backup RPC Endpoints      │  │
│  │  Decision Engine    │      │   Grid Trigger Logic         │  │
│  │  Hardware Signer    │      │   Stop-Loss Rules            │  │
│  └────────┬────────────┘      └─────────────┬────────────────┘  │
│           │                                 │                   │
│           │  secp256k1 sign (_STD_)         │  secp256k1 sign   │
└───────────┼─────────────────────────────────┼───────────────────┘
            │                                 │
            ▼                                 ▼
   ┌─────────────────────────────────────────────────────────┐
   │               Base Mainnet (L2)                         │
   │                                                         │
   │   ┌─────────────────────────────────────────────────┐   │
   │   │             YieldSenseKeeper.sol                │   │
   │   │                                                 │   │
   │   │   deposit()      → user deposits capital       │   │
   │   │   executeTrade() → TEE-signed trade            │   │
   │   │   executeHarvest()→ TEE-signed harvest          │   │
   │   │   withdraw()     → user withdraws + fee        │   │
   │   └──────────────────────────┬──────────────────────┘   │
   └──────────────────────────────┼──────────────────────────┘
                                  │
            ┌─────────────────────┴─────────────────────┐
            │                                           │
   ┌────────▼──────────┐                       ┌────────▼──────────┐
   │  On-Chain Indexing│                       │  External APIs    │
   │  (Frontend View)  │                       │  Gecko/Dex/Llama  │
   └───────────────────┘                       └───────────────────┘
```

---

## 4. Codebase Structure

| Directory/File | Responsibility |
|---|---|
| `src/index.ts` | Main harvest worker (One-shot task). |
| `src/processor.ts` | Grid keeper worker (Price monitor + trade executor). |
| `src/rpcProvider.ts` | **NEW:** Custom provider handling automated RPC failover and rotation. |
| `src/yieldEngine/` | First-principles yield estimation engine (on-chain logs + gauge data). |
| `contracts/` | `YieldSenseKeeper.sol` — Unified vault with P-256 attestation. |
| `scripts/` | Deployment and attestation scripts (including Safe multisig tools). |
| `frontend/` | Next.js dashboard with `viem`-based event indexing. |

---

## 5. Setup & Installation

### Prerequisites
- **Node.js** v20+
- **Base Mainnet RPC** (Infura, Alchemy, or QuickNode)
- **Acurast Console Account**

### Installation
```bash
npm install
npm run build
```

### Deployment to Acurast
```bash
acurast deploy YieldSense
```

---

## 6. Environment Configuration

### Example `.env` (Mainnet)

```dotenv
# ── Execution RPC (with failover) ─────────────────────────────────
RPC_URL=https://mainnet.base.org
RPC_FALLBACK_URLS=https://base-mainnet.public.blastapi.io,https://base.meowrpc.com

# ── Contract Addresses ────────────────────────────────────────────
KEEPER_ADDRESS=0x757d30F22692Bf81aE3E3feb0F8FB7cAD48F7CEF
POOL_ADDRESS=0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d

# ── Strategy Parameters ────────────────────────────────────────────
STRATEGY_TVL_USD=10000
EFFICIENCY_MULTIPLIER=1.5
MIN_NET_REWARD_USD=1.0
MAX_GAS_USD=25.0
COOLDOWN_SEC=3600

# ── Telemetry ─────────────────────────────────────────────────────
TELEMETRY_URL=https://yieldsense.huzaifamalik.tech/api/telemetry
```

---

## 7. How the Project Works (Flow)

### One-Shot Harvest Lifecycle
1. **Wake up:** Acurast triggers the task based on the scheduled interval (e.g., 1 hour).
2. **Failover Probe:** The worker tests available RPCs to find a responsive endpoint.
3. **Yield Audit:** Indexes the last 3,600 seconds of swap logs and gauge reward rates.
4. **Profitability Check:** Calculates if `Gross Reward - Gas Cost > 0` after applying the `EFFICIENCY_MULTIPLIER`.
5. **Hardware Signing:** Signs the execution payload inside the enclave.
6. **Broadcast & Exit:** Submits the transaction and exits immediately to release resources.

### Frontend Indexing Flow
1. **Connect:** Frontend connects to the user's wallet and the active RPC.
2. **Fetch Events:** Uses `getContractEvents` to scan for `HarvestExecuted` and `TradeExecuted` logs.
3. **Display:** Renders the "Guardian Ledger" using on-chain data as the source of truth.

---

## 8. Known Issues / Limitations
1. **Single-user worker:** Currently, each worker instance monitors one `USER_ADDRESS`.
2. **Aerodrome Epoch Transition:** Yield estimation may show minor variance during epoch flips (Wednesday midnight UTC).

---

## 9. Next Steps / Roadmap
- [ ] **Multi-user registry:** Allow a single worker to process harvests for multiple vault depositors.
- [ ] **Permissionless Attestation:** Fully automate the P-256 certificate chain validation to remove the multisig bypass.
- [ ] **Advanced Slippage Guard:** Dynamic slippage adjustment based on pool volatility.

---

## 10. Additional Notes

### Multisig Governance
The `YieldSenseKeeper` is owned by a Gnosis Safe multisig. All administrative changes (adding new TEE processors, changing fees) require a `M-of-N` signature threshold, ensuring protocol security against compromised developer keys.
## Low Priority / Enhancements

- [ ] **Multi-pool harvest** — extend the harvest worker to manage multiple pools in a single run.
- [ ] **Hardened forward projection** — implement epoch-aware reward projection in `forwardAerodrome.ts` once Aerodrome epoch data is reliably available.
- [ ] **Telemetry sink** — pipe structured JSON telemetry to an external service (e.g. Datadog, custom webhook) instead of only stdout.

---

## 10. Additional Notes

### Unified Contract Context

Previously, the codebase utilized two separate keeper contracts. This has now been updated so that both **harvesting** (`executeHarvest`) and **grid trading** (`executeTrade`) are managed by a single unified contract: `contracts/YieldSenseKeeper.sol`.

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
