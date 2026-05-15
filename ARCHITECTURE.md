# YieldSense Technical Architecture

YieldSense is an autonomous, trust-minimized yield engine that bridges the gap between high-performance off-chain computation and secure on-chain execution using **Acurast Trusted Execution Environments (TEEs)** on **Base Mainnet**.

## System Overview

The architecture is divided into three distinct layers: the **User Interface (Control Plane)**, the **Acurast Enclave (Decision Plane)**, and the **EVM Smart Contracts (Settlement Plane)**.

```mermaid
graph TD
    User((User)) -->|Signs Intent| FE[Next.js Dashboard]
    FE -->|EIP-712 Encrypted Payload| TEE[Acurast TEE Enclave]
    
    subgraph Decision Plane: Acurast TEE (One-Shot Task)
        TEE -->|Fetch APR| APR[Consensus API]
        TEE -->|Check Gas| Failover[RPC Failover Layer]
        Failover -->|Public/Private Endpoints| RPC[Base Mainnet RPC]
        TEE -->|Compute| DE[Decision Engine]
        DE -->|Profit > Gas * 1.5| Signer[Hardware Signer]
    end
    
    Signer -->|Signed Attestation| Keeper[YieldSenseKeeper.sol]
    Keeper -->|Execute Harvest/Trade| LP[Aerodrome/Moonwell]
    
    RPC -->|On-Chain Events| FE
    TEE -->|Live Logs| Telemetry[Netlify Telemetry API]
    Telemetry -->|Streaming| FE
```

---

## 1. Control Plane: Next.js Frontend
The frontend is the entry point for user capital and strategy parameterization.
- **Strategy Encryption**: User intents (stop-loss prices, grid boundaries, slippage) are signed via **EIP-712**, ensuring that only the authorized TEE worker can verify and act upon them.
- **On-Chain Indexing**: The "Guardian Ledger" (Execution History) now bypasses telemetry APIs for historical data, instead indexing `HarvestExecuted` and `TradeExecuted` events directly from the blockchain via `viem`. This ensures a single source of truth for all settled actions.
- **Real-time Telemetry**: Streams live logs directly from the active Acurast worker via a secure Netlify API relay for immediate feedback during execution.

## 2. Decision Plane: Acurast TEE Enclave
The "brain" of the protocol runs as a **One-Shot Task** inside hardware-isolated enclaves.
- **One-Shot Execution**: To align with Acurast’s serverless architecture and prevent "boot storms," the processor runs as a discrete task that executes its logic and shuts down cleanly. This ensures predictable lifecycle management and resource efficiency.
- **RPC Failover Layer**: A robust transport layer in `src/rpcProvider.ts` handles automated failover. If the primary Infura/Alchemy endpoint hits a 429 rate limit or timeout, the worker automatically rotates to secondary public RPCs to guarantee completion.
- **Autonomous Decisioning**: The `Decision Engine` evaluates the profitability formula:
  `V * r * Δt * (1-τ) > Cgas * θ`
- **Isolation**: Key material is generated within the enclave via `getAcurastStd()`. The private key is never exposed to the developer or the host machine.

## 3. Settlement Plane: Smart Contracts
The `YieldSenseKeeper.sol` acts as the final gatekeeper for vault funds on Base Mainnet.
- **Attestation Verification**: The contract uses the `Acurast P-256` signature verification module. It only accepts `executeHarvest` or `executeTrade` calls if the signature matches a whitelisted hardware processor.
- **Multisig Governance**: Administrative actions (like attesting new processors or updating parameters) are governed by a **Gnosis Safe Multisig**, ensuring no single point of failure for protocol control.

---

## Execution Flow: The "One-Shot" Lifecycle
1. **Trigger**: Acurast schedules the worker (e.g., every 1 hour).
2. **Boot**: The worker initializes providers and probes the RPC failover chain.
3. **Scan**: It indexes swap logs and reward emissions to calculate a "Robust Yield Estimate."
4. **Audit**: It checks the current L2 gas price, failing over to backup providers if needed.
5. **Decision**: If `Net Profit > Gas Cost * 1.5`, it moves to signing.
6. **Execution**: The signed blob is submitted to the `YieldSenseKeeper`. The worker waits for confirmation or timeout.
7. **Exit**: The worker flushes telemetry and exits with `process.exit(0)`, signaling a successful completion to the Acurast orchestrator.
