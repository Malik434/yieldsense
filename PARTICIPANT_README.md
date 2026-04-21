# YieldSense Base Sepolia Testnet Guide

Welcome to the YieldSense private testnet! This guide will walk you through interacting with our **Confidential Strategy Command Center** deployed on Base Sepolia, powered by the Acurast TEE (Trusted Execution Environment).

## The Goal
YieldSense allows you to run high-frequency DeFi strategies (like grid trading and stop-losses) without ever storing your parameters on-chain where MEV bots can see them. Your parameters are securely encrypted, stored inside an Acurast Pixel 8 Secure Enclave, and executed autonomously.

---

## Step 1: Connect to Base Sepolia
1. Open your Web3 wallet (MetaMask).
2. Switch your network to **Base Sepolia**.
   - If you don't have it added, you can add it via [Chainlist](https://chainlist.org/chain/84532) (include testnets).
3. Connect your wallet to the YieldSense frontend.

## Step 2: Get Testnet Assets
In the **00 · TESTNET ONBOARDING** section of the UI:
1. **Get ETH:** Click the Coinbase Faucet link to get Base Sepolia ETH (required for gas fees).
2. **Get Mock USDC:** Click the `MINT 1000 MOCK USDC` button to get testnet capital for the vault.

## Step 3: Deposit to Vault
Scroll down to **01 · STRATEGY COMMAND CENTER**.
1. Enter an amount of USDC (e.g., 500).
2. Click **APPROVE USDC** (this allows the contract to move your funds).
3. Click **DEPOSIT TO VAULT** to commit your capital.

## Step 4: The TEE Handshake (Set Your Confidential Strategy)
This is the core of YieldSense's privacy layer.
1. In the **CONFIDENTIAL STRATEGY** box, set your:
   - **Invisible Stop-Loss Price** (e.g., `0.94`)
   - **Grid Upper/Lower Bounds** (e.g., `1.02` / `0.96`)
2. Click **SIGN & COMMIT TO TEE**.
3. **What's Happening Here?**
   - Your wallet will prompt you to sign an `eth_signTypedData_v4` (EIP-712) message.
   - We are **not** sending a blockchain transaction. You pay no gas.
   - The frontend encrypts your parameters and sends them via HTTPS relay directly into the Acurast Processor's local storage (`_STD_.storage`).
   - *Result:* The processor now knows your strategy, but the blockchain (and MEV searchers) do not.

## Step 5: Verify Hardware Execution
Scroll down to **02 · LIVE ALPHA DASHBOARD**.
- Watch the **HARDWARE PROOF LOGS** in the Testnet Onboarding section.
- Every minute, the Acurast Processor evaluates your strategy.
- If the simulated price triggers your grid bounds, the TEE will generate a P-256 hardware signature and execute the trade on-chain.
- You will see the trade appear in the **TRANSACTION HISTORY** table. You can click the Blockscout link to verify that the transaction was indeed sent by the Acurast Keeper contract on your behalf.

---

## Why this Architecture?
If you put a stop-loss on a standard DEX smart contract, it's public. MEV searchers will intentionally push the price down to trigger your stop-loss and buy your assets at a discount (hunting).

By moving the parameter storage and evaluation into an off-chain Trusted Execution Environment (Acurast), YieldSense ensures:
1. **Total Privacy:** Your strategy parameters are never broadcasted to the mempool.
2. **Front-run Protection:** The execution transaction is signed securely inside the hardware enclave only at the exact moment the market condition is met.
3. **Decentralized Trust:** The smart contract uses cryptographic attestation to verify that the execution *must* have come from an unmodified Acurast node running the YieldSense code.
