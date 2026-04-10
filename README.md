# YieldSense

YieldSense is an automated yield harvesting and profitability checker designed to run in an [Acurast](https://acurast.com/) Trusted Execution Environment (TEE). It monitors an Aerodrome liquidity pool (WETH/USDC) on Base Sepolia, calculates the net reward versus gas costs, and triggers an on-chain harvest transaction only when compounding is profitable.

## Features

- **True Yield Engine** (`src/yieldEngine/`): First-principles **fee APR** from on-chain **Swap** logs and **reward APR** from **gauge** `rewardRate` (when `GAUGE_ADDRESS` is set), plus rolling TVL from reserves, EWMA-smoothed emissions, and a data-quality **confidence** score. **Hybrid mode** (`YIELD_FALLBACK_MODE=auto`) blends in legacy REST APR consensus when RPC coverage or confidence is weak.
- **Legacy API consensus** (GeckoTerminal, DexScreener, DefiLlama): Still used as fallback or benchmarking via `src/realtimeApr.ts`.
- **Smart Profitability Checking**: Calculates accumulated rewards using **total APR** (fee + reward) and ETH pricing, then applies deterministic execution guardrails.
- **Adaptive Runtime Loop**: Emits a recommended next-check interval based on APR regime and gas environment for Acurast-friendly scheduling.
- **Gas Optimization**: Compares estimated gas costs against expected yield and enforces an efficiency multiplier (default 1.5x) before triggering transactions.
- **Acurast TEE Ready**: Configured to be bundled via Webpack for seamless deployment to Acurast workers.
- **Cross-Ecosystem Utility**: Includes a utility (`deriveAddress.ts`) to convert Substrate SS58 worker addresses to EVM addresses for cross-chain compatibility.

## Prerequisites

- Node.js (v16+)
- npm or yarn
- An Acurast Worker Key (provided as an environment variable in the TEE)

## Installation

Clone the repository and install the required dependencies:

```bash
npm install
```

## Project Structure

- `src/index.ts`: The main application logic. Fetches data, calculates profitability, and broadcasts transactions.
- `src/yieldEngine/`: Modular yield estimation (`getRobustYieldEstimate`), RPC fee / gauge indexers, smoothing, confidence, optional forward projection stub.
- `src/deriveAddress.ts`: Utility script to decode a Polkadot/Acurast SS58 address into an EVM-compatible hex address.
- `webpack.config.js`: Bundles the application into a single file (`dist/bundle.js`) optimized for the Node environment.
- `tsconfig.json`: TypeScript configuration (configured for ES modules and modern Node environments).

## Configuration

Before running the bot, configure environment variables for your strategy and deployment:

```typescript
RPC_URL=https://sepolia.base.org
KEEPER_ADDRESS=...
POOL_ADDRESS=...
STRATEGY_TVL_USD=10000
EFFICIENCY_MULTIPLIER=1.5
POOL_FEE_RATE=0.003
MIN_APR_CONFIDENCE=0.55
APR_FRESHNESS_WINDOW_SEC=1200
MIN_NET_REWARD_USD=1
MAX_GAS_USD=30
COOLDOWN_SEC=300
STATE_PATH=.yieldsense-state.json

# True Yield Engine (optional; hybrid fallback recommended on testnet)
# GAUGE_ADDRESS=0x...           # Aerodrome-style gauge for reward APR
# LP_TOKEN_ADDRESS=0x...        # Defaults to POOL_ADDRESS (V2 pair)
# REWARD_TOKEN_ADDRESS=0x...  # Override reward token for pricing
FEE_WINDOW_SEC=604800
FEE_MAX_BLOCKS=80000
LOG_CHUNK_SIZE=3000
REWARD_EWMA_HALF_LIFE_SEC=259200
MIN_YIELD_CONFIDENCE=0.55
YIELD_FALLBACK_MODE=auto
# YIELD_FORWARD_PROJECTION=true
# STRATEGY_DELTA_USD=10000
# POOL_FEE_BPS=30
# APY_COMPOUNDS_PER_YEAR=365
```

### Read-only hybrid: mainnet yield, Sepolia execution

To exercise the yield engine against **live** Aerodrome pool/gauge data without spending mainnet gas on harvests:

- Set **`DATA_RPC_URL`** (or **`MAINNET_DATA_RPC_URL`**) to a **Base mainnet** RPC (public or free tier).
- Keep **`RPC_URL`** on **Base Sepolia** (or your execution testnet).
- Set **`POOL_ADDRESS`** / **`GAUGE_ADDRESS`** to the **real mainnet** pool and gauge you want to mirror.
- Set **`KEEPER_ADDRESS`** to your keeper **on Sepolia** (same worker key as `acurastWorker` there).

The worker will compute APR from mainnet logs/state, estimate gas from Sepolia, and broadcast **`executeHarvest`** only to the Sepolia keeper. Telemetry includes `hybridReadMainnetExecuteTestnet`, `yieldChainId`, and `executionChainId`.

Optional **`YIELD_CHAIN_ID=8453`** fixes the yield engine’s chain metadata if your data RPC does not report chain id correctly.

**Troubleshooting `lastHarvest` / `BAD_DATA` / `value="0x"`:** `KEEPER_ADDRESS` must be a deployed `YieldSenseKeeper` on the **same network as `RPC_URL`**. A common mistake is `RPC_URL=https://mainnet.base.org` with a keeper that only exists on **Base Sepolia** — use the hybrid env above (Sepolia `RPC_URL` + mainnet `DATA_RPC_URL`) or redeploy the keeper on mainnet.

### Environment Variables

To execute harvest transactions, the application requires the following environment variable to be set (typically provided securely by the Acurast execution environment):

- `ACURAST_WORKER_KEY`: The private key of the wallet triggering the transaction.

The worker emits structured JSON telemetry for:
- **Yield**: `feeApr`, `rewardApr`, `totalApr`, `estimatedApy`, `forwardAprEstimate`, `dataSourcesUsed`, `diagnostics`
- Legacy APR / source health when fallback triggers
- Profitability decision reason
- Suggested next check interval
- Harvest submission and confirmation

## Build & Run

To compile the application into a single CommonJS bundle for deployment:

```bash
npm run build
```

This will output `bundle.js` into the `dist/` directory. You can run the bundle locally to test the logic:

```bash
node dist/bundle.js
```

## Utilities

If you need to derive an EVM address from an Acurast SS58 worker address, you can run the provided utility script. Make sure to paste your address in `src/deriveAddress.ts` first, then run:

```bash
npx tsx src/deriveAddress.ts
```

## License

ISC