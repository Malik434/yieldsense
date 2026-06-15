# Acurast Processor Operations

YieldSense uses two dedicated Acurast processor families:

- `YieldSenseYieldExecutor`: yield vault harvesting and vault monitoring.
- `YieldSenseGridExecutor`: grid strategy monitoring and grid trade execution.

Processor deployment addresses are treated as replaceable infrastructure. Vault
contracts authorize execution through `ExecutorRegistry`, not by storing raw
Acurast deployment addresses in user strategy state.

## Register a Processor

```bash
EXECUTOR_REGISTRY_ADDRESS=0x... \
PROCESSOR_ADDRESS=0x... \
PROCESSOR_ROLE=YIELD_EXECUTOR \
ACTION=register \
npx hardhat run scripts/rotateProcessor.cjs --network baseMainnet
```

For grid execution:

```bash
EXECUTOR_REGISTRY_ADDRESS=0x... \
PROCESSOR_ADDRESS=0x... \
PROCESSOR_ROLE=GRID_EXECUTOR \
ACTION=register \
npx hardhat run scripts/rotateProcessor.cjs --network baseMainnet
```

`DEPLOYMENT_HASH` and `CODE_HASH` may be supplied when the Acurast deployment
or bundle hash is available. Otherwise the script stores zero hashes for capped
testing.

## Rolling Rotation

1. Deploy the new Acurast job.
2. Wait for the processor to emit/report its EVM address.
3. Register the new address in `ExecutorRegistry`.
4. Confirm `isAuthorized(processor, role) == true`.
5. Let in-flight work on the old processor drain.
6. Revoke the old processor address.

```bash
EXECUTOR_REGISTRY_ADDRESS=0x... \
PROCESSOR_ADDRESS=0x... \
PROCESSOR_ROLE=GRID_EXECUTOR \
ACTION=revoke \
npx hardhat run scripts/rotateProcessor.cjs --network baseMainnet
```

## Testing Ownership

During capped mainnet testing, the deployer EOA owns `ExecutorRegistry`,
`YieldSenseKeeper`, and `AerodromeAutocompounder`.

When testing is complete, transfer ownership with `transferOwnership(safe)` on
each Ownable2Step contract, then accept ownership from the Safe.

No processor, strategy, or user migration is required when ownership moves to a
Safe.

## Pair and Yield Pool Configuration

The grid frontend discovers pairs from `/api/grid/pairs`.

- `AERO/USDC` is enabled by default.
- `ETH/USDC` is enabled by default and uses WETH as the base token.
- `ACU/USDC` is shown only when `NEXT_PUBLIC_ACU_TOKEN_ADDRESS` and
  `NEXT_PUBLIC_ACU_USDC_POOL_ADDRESS` are set.

For complete mainnet deployment, `scripts/deployCompleteMainnet.cjs` configures
`AERO/USDC` and `ETH/USDC` on-chain. It configures `ACU/USDC` only when
`ACU_ADDRESS` is set.

The yield vault uses the original Aerodrome AERO/USDC V2-style pool and gauge
configured in the deployment scripts.
