# YieldSense

YieldSense is an autonomous DeFi yield harvesting and confidential grid-trading platform designed to run inside an [Acurast](https://acurast.com/) Trusted Execution Environment (TEE). It monitors Aerodrome liquidity pools and Moonwell lending markets on Base, calculates the net reward versus gas costs, and triggers on-chain harvest and trade transactions only when they are provably profitable.

## Core Architecture

YieldSense separates data ingestion, decisioning, and signing so sensitive key material remains inside the trusted execution boundary at all times.

- **Frontend (Netlify):** Next.js dashboard providing a premium UI for deposits, EIP-712 strategy parameter signing (MEV protection), and real-time telemetry streaming from the Acurast Hub.
- **Backend (Acurast TEE):** Secure enclaves running our Node.js bundles (`index.ts` for harvesting, `processor.ts` for grid trading). The TEE holds the private keys, evaluates the on-chain profitability logic, and pushes signed transactions to the blockchain.
- **Smart Contracts (Base Sepolia):** `YieldSenseKeeper.sol` is a unified vault handling both autonomous harvesting and grid trade execution. It natively verifies Acurast hardware attestations to ensure that only unmodified, official YieldSense code can access vault funds.

## Recent Updates & Progress
- **Unified Smart Contracts:** Both Harvest execution and Grid Trading logic are now securely managed by a single unified `YieldSenseKeeper.sol` contract.
- **Netlify Firewall Bypass:** The telemetry pipeline now successfully bypasses Netlify's Edge Firewall (WAF) using User-Agent spoofing, allowing the headless Acurast data center nodes to stream live execution logs directly to the dashboard.
- **EIP-712 Handshake:** Fully implemented the secure strategy delivery pipeline. Users configure stop-loss rules on the frontend, sign them with MetaMask, and the Acurast TEE decrypts and verifies the payload at runtime.
- **CLI Deployment:** `acurast.json` is fully configured with proper environment variable mapping (`TELEMETRY_URL`, `GRID_CONFIG_JSON`, etc.) for immediate push-button deployment via the Acurast CLI.

## Prerequisites

- Node.js (v18+)
- An Acurast Worker Key (for testing) or an active Acurast Console account.
- Base Sepolia ETH for gas.

## Installation & Deployment

1. **Clone & Install:**
```bash
npm install
```

2. **Build the TEE Bundles:**
```bash
npm run build
```
*(This uses Webpack to bundle `src/index.ts` and `src/processor.ts` into isolated, TEE-ready `dist/*.bundle.cjs` files).*

3. **Deploy the Acurast Worker (Backend):**
```bash
acurast deploy YieldSense
```
*(Note: Do not run this inside your Netlify build command. Netlify hosts the Next.js frontend; Acurast hosts the backend workers).*

4. **Attest the Processor:**
Take the newly generated Processor Address from the Acurast CLI and whitelist it on your smart contract to grant it trading authority.

## Environment Variables

Your `.env` file should include the following to deploy locally:

```typescript
RPC_URL=https://sepolia.base.org
DATA_RPC_URL=https://mainnet.base.org
KEEPER_ADDRESS=0x488147C822b364a940630075f9EACD080Cc16234
POOL_ADDRESS=0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59
STRATEGY_TVL_USD=10000
TELEMETRY_URL=https://yieldsense.netlify.app/api/telemetry
PROCESSOR_SHARED_SECRET=...
USER_ADDRESS=...
```

## Security Model

The protocol utilizes dual-layer security:
1. **Hardware Verification:** The smart contract natively verifies the P-256 signature of the Acurast TEE to guarantee the execution enclave is running an unmodified version of the protocol code.
2. **Deterministic Guardrails:** The TEE code enforces strict, gas-aware execution logic (circuit breakers, cooldowns, efficiency multipliers) before ever signing a transaction, ensuring capital efficiency at all times.

## License
ISC