# YieldSense Security Model

YieldSense is built on a "Defense in Depth" philosophy, combining hardware-level isolation with cryptographic on-chain verification.

## 1. The Trust Anchor: Acurast TEE
The core security guarantee is that **code is law** inside the enclave.
- **Remote Attestation**: Every transaction submitted to the `YieldSenseKeeper` includes a cryptographic proof (Remote Attestation) that the code hasn't been tampered with.
- **Hardware-Locked Secrets**: Signing keys are generated in the Secure Element of the hardware. Even with root access to the server, the private key cannot be extracted.

## 2. MEV & Front-running Protection
YieldSense implements two layers of protection against predatory bots:
- **Private Broadcast**: Signed transactions are pushed via private RPC endpoints (QuickNode/Alchemy) to bypass the public mempool.
- **Slippage Enforcer**: Every grid trade and harvest-swap includes a hardcoded or user-signed slippage limit (default 0.5%). The TEE will refuse to sign a transaction if the routing path doesn't satisfy these economic constraints.

## 3. Cryptographic Handshake (EIP-712)
Strategy delivery is secured via the **EIP-712** standard.
- **Non-Repudiation**: Users sign their strategy parameters (e.g., "Stop-loss at $3,200") with their own wallet.
- **Enclave Verification**: The TEE worker recovers the address from the signature. It only executes strategies for users who have provided a valid, cryptographically-signed intent. This prevents "Ghost Trades" or unauthorized parameter tampering.

## 4. Smart Contract Guardrails
The `YieldSenseKeeper.sol` is designed with strict boundary conditions:
- **Whitelisted Processors**: Only hardware processors that have been manually whitelisted by the protocol owner can trigger vault actions.
- **Inactivity Guard**: To mitigate the risk of TEE downtime, a secondary permissioned multisig can trigger emergency harvests if the autonomous agent hasn't checked in for 48 hours.
- **Immutable Logic**: Critical profitability constants (Efficiency Multipliers) are defined at the TEE level but verified via the `PayloadHash` on-chain.

## 5. Risk Disclosures
- **Oracle Risk**: While YieldSense uses a multi-source consensus for APR, spot price relies on Uniswap V3 `slot0` data. We mitigate this using a **Divergence Guard** that compares the on-chain price against an off-chain oracle (Gecko) before execution.
- **Contract Risk**: While the Acurast TEE is secure, bugs in the underlying lending protocols (Aerodrome/Moonwell) can still impact the vault.

---

## Technical Audit Checkpoints
For security researchers, the following functions represent the protocol's attack surface:
1. `YieldSenseKeeper.executeHarvest()`: Entry point for TEE-signed rewards compounding.
2. `YieldSenseKeeper.executeTrade()`: Entry point for confidential grid execution.
3. `processor.monitorAndExecuteGrid()`: The TEE's internal price monitoring loop.
