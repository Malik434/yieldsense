# YieldSense

YieldSense is an automated yield harvesting and profitability checker designed to run in an [Acurast](https://acurast.com/) Trusted Execution Environment (TEE). It monitors an Aerodrome liquidity pool (WETH/USDC) on Base Sepolia, calculates the net reward versus gas costs, and triggers an on-chain harvest transaction only when compounding is profitable.

## Features

- **Realtime APR Consensus**: Aggregates APR from GeckoTerminal, DexScreener, and DefiLlama with freshness and confidence gating.
- **Smart Profitability Checking**: Calculates accumulated rewards using dynamic APR and ETH pricing, then applies deterministic execution guardrails.
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
```

### Environment Variables

To execute harvest transactions, the application requires the following environment variable to be set (typically provided securely by the Acurast execution environment):

- `ACURAST_WORKER_KEY`: The private key of the wallet triggering the transaction.

The worker emits structured JSON telemetry for:
- APR consensus and source health
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