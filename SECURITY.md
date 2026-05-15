# YieldSense Security Architecture

YieldSense is designed with a **defense-in-depth** strategy, combining hardware-level isolation, cryptographic attestations, and decentralized governance to protect user capital.

## 1. Hardware-Level Isolation (Acurast TEE)

The "Decision Plane" of the protocol runs exclusively inside **Trusted Execution Environments (TEEs)**.
- **Private Key Sovereignty:** Signing keys are generated within the enclave's secure element. They never leave the hardware boundary and are inaccessible even to the protocol developers.
- **One-Shot Isolation:** By running as a **One-Shot Task**, the worker process has a limited lifecycle. It initializes, executes, and terminates, minimizing the attack surface for long-running memory exploits.
- **Encrypted Environment:** All sensitive configuration (stop-loss rules, secrets) is injected into the TEE via encrypted environment variables or signed EIP-712 payloads.

## 2. On-Chain Attestation (RIP-7212)

The `YieldSenseKeeper.sol` contract acts as an on-chain gatekeeper that verifies the source of every execution.
- **P-256 Signature Verification:** The contract utilizes the `RIP-7212` precompile (available on Base) to natively verify P-256 signatures from Acurast hardware.
- **Processor Whitelisting:** Only processors that have provided a valid hardware attestation (proving they are running unmodified YieldSense code) are authorized to call `executeHarvest` or `executeTrade`.
- **Nonce Bitmap:** Every transaction is protected by a mandatory nonce bitmap to prevent replay attacks across different workers or timeframes.

## 3. Governance & Administrative Security

Protocol-level permissions are strictly controlled to prevent "Rug Pull" or centralized failure scenarios.
- **Gnosis Safe Multisig:** The `YieldSenseKeeper` owner is a **multisig wallet** (0x081a...c64a). Any change to protocol fees, whitelisted processors, or admin parameters requires a consensus of signatures.
- **Two-Day Timelock:** Critical administrative changes are subject to a 48-hour timelock, giving users time to withdraw funds if they disagree with a proposed update.
- **Non-Custodial Logic:** The smart contract logic is restricted to interacting only with authorized yield sources (Aerodrome, Moonwell). There is no "drain" function or administrative path to transfer principal funds to an external address.

## 4. Reliability & Network Security

- **RPC Failover Transport:** To prevent "Denial of Service" attacks via RPC rate-limiting, the worker implements an automated failover mechanism. It can rotate through a pool of distinct providers to ensure that time-critical trades (like stop-losses) are always submitted.
- **Deterministic Guardrails:** The TEE code contains hardcoded "Circuit Breakers" that skip execution if yield data is stale, gas is abnormally high, or the profitability confidence score is too low.

## Reporting a Vulnerability

If you discover a security vulnerability, please do not open a public issue. Instead, contact the security team directly at security@yieldsense.tech or via our bug bounty program on Immunefi (coming soon).
- **Immutable Logic**: Critical profitability constants (Efficiency Multipliers) are defined at the TEE level but verified via the `PayloadHash` on-chain.

## 5. Risk Disclosures
- **Oracle Risk**: While YieldSense uses a multi-source consensus for APR, spot price relies on Uniswap V3 `slot0` data. We mitigate this using a **Divergence Guard** that compares the on-chain price against an off-chain oracle (Gecko) before execution.
---

## Technical Audit Checkpoints
For security researchers, the following functions represent the protocol's attack surface:
1. `YieldSenseKeeper.executeHarvest()`: Entry point for TEE-signed rewards compounding.
2. `YieldSenseKeeper.executeTrade()`: Entry point for confidential grid execution.
3. `processor.monitorAndExecuteGrid()`: The TEE's internal price monitoring loop.
