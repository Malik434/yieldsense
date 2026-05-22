# YieldSense

YieldSense is an autonomous DeFi yield harvesting and confidential grid-trading platform designed to run inside an [Acurast](https://acurast.com/) Trusted Execution Environment (TEE) on **Base Mainnet**. It monitors Aerodrome liquidity pools and Moonwell lending markets, calculates net rewards versus gas costs, and triggers on-chain transactions only when they are provably profitable.

## Core Architecture

YieldSense separates data ingestion, decisioning, and signing so sensitive key material remains inside the trusted execution boundary at all times.

- **Frontend (Netlify):** Next.js dashboard providing a premium UI for deposits, EIP-712 strategy parameter signing (MEV protection), and real-time telemetry. Execution history is indexed directly from **on-chain events**.
- **Backend (Acurast TEE):** Secure enclaves running our Node.js bundles as **one-shot tasks**. The TEE holds the private keys, evaluates on-chain profitability logic with **automated RPC failover**, and pushes signed transactions.
- **Smart Contracts (Base Mainnet):** `YieldSenseKeeper.sol` is a unified vault handling both autonomous harvesting and grid trade execution. It natively verifies Acurast hardware attestations and is governed by a **Gnosis Safe Multisig**.

## Recent Updates & Progress
- **One-Shot Task Model:** Refactored the Acurast processor into a discrete execution model to eliminate "boot storms" and align with serverless TEE scheduling.
- **Automated RPC Failover:** Implemented a robust transport layer that automatically rotates through backup RPC endpoints when encountering 429 rate limits or timeouts.
- **On-Chain Event Indexing:** The dashboard now fetches execution history directly from the blockchain, ensuring perfect data integrity without relying on telemetry logs for historical records.
- **Multisig Governance:** Protocol administration and processor attestation are now secured by a Gnosis Safe multisig (0x081a...c64a).
New update

## Prerequisites

- Node.js (v18+)
- An Acurast Console account.
- Base Mainnet ETH for gas.

## Installation & Deployment

1. **Clone & Install:**
```bash
npm install
```

2. **Build the TEE Bundles:**
```bash
npm run build
```
*(This bundles `src/index.ts` and `src/processor.ts` into isolated, TEE-ready `dist/*.bundle.cjs` files).*

3. **Deploy the Acurast Worker:**
```bash
acurast deploy YieldSense
```

4. **Attest the Processor:**
The generated Processor Address must be whitelisted on the smart contract. For production, this is done via a **Gnosis Safe** proposal using `scripts/attestProcessor.cjs`.

## Environment Variables

Your `.env` file should include the following for mainnet operation:

```typescript
RPC_URL=https://mainnet.base.org
RPC_FALLBACK_URLS=https://base-mainnet.public.blastapi.io,https://base.meowrpc.com
KEEPER_ADDRESS=0x757d30F22692Bf81aE3E3feb0F8FB7cAD48F7CEF
POOL_ADDRESS=0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d
STRATEGY_TVL_USD=10000
TELEMETRY_URL=https://yieldsense.huzaifamalik.tech/api/telemetry
USER_ADDRESS=...
```

## Security Model

The protocol utilizes dual-layer security:
1. **Hardware Verification:** The smart contract natively verifies the P-256 signature of the Acurast TEE to guarantee the execution enclave is running unmodified protocol code.
2. **Deterministic Guardrails:** The TEE code enforces strict, gas-aware execution logic (circuit breakers, cooldowns) before signing any transaction.
3. **Multisig Control:** All administrative gates are secured by a team-governed multisig wallet.

## Operational Notes

Run verification scripts against the intended network before changing processor, keeper, or multisig configuration.

## License
ISC
