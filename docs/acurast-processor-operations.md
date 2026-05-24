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
