# YieldSense Test Cases

## APR Logic
- `TC_APR_01`: all sources valid and fresh -> consensus is usable and confidence >= threshold.
- `TC_APR_02`: one source missing but two strong sources present -> consensus remains usable.
- `TC_APR_03`: all sources stale -> consensus unusable and `apr` is `null`.
- `TC_APR_04`: one extreme outlier source -> outlier filtered, consensus remains near median.

## Profitability and Harvest Decision
- `TC_DEC_01`: high gas cost -> `shouldExecute=false`, reason `gas_too_high`.
- `TC_DEC_02`: reward below minimum -> `shouldExecute=false`, reason `min_reward_not_met`.
- `TC_DEC_03`: profitability threshold exceeded -> `shouldExecute=true`, reason `profitable`.
- `TC_DEC_04`: API failures exceed max streak -> circuit breaker reason `circuit_breaker_api_failures`.

## Signature and Harvest Authorization
- `TC_SIG_01`: valid payload signed by worker -> signature verification returns true.
- `TC_SIG_02`: payload signed by different wallet -> verification returns false.
- `TC_SIG_03`: replay marker set for payload hash -> second use rejected by keeper mapping.

## Runtime State
- `TC_STATE_01`: missing state file -> defaults loaded.
- `TC_STATE_02`: saved state reloads exactly for apr/failure/reason metadata.

## Multi-Pool Smoke (Live APIs)
- `TC_POOL_01`: known active pool should usually produce usable consensus.
- `TC_POOL_02`: zero/unknown pool should produce unusable consensus with source errors.
- `TC_POOL_03`: another unknown pool should produce no-trade decision and useful diagnostics.

## Commands
- Deterministic suite: `npm test`
- Multi-pool smoke: `npm run test:pools`
- Custom pools: `npx tsx src/poolSmoke.ts <pool1> <pool2> <pool3>`
