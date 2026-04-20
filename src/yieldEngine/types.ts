import type { JsonRpcProvider } from "ethers";

export type DataSourceTag =
  | "rpc:swapLogs"
  | "rpc:gauge"
  | "rpc:poolState"
  | "subgraph:aerodrome"
  | "oracle:twap"
  | "oracle:chainlink"
  | "oracle:spotReserves"
  | "api:defillama"
  | "api:gecko"
  | "api:dexscreener";

export interface RobustYieldEstimate {
  feeApr: number;
  rewardApr: number;
  totalApr: number;
  estimatedApy: number;
  confidence: number;
  dataSourcesUsed: DataSourceTag[];
  forwardAprEstimate?: {
    rewardApr: number;
    totalApr?: number;
    epochId?: string;
    validFrom?: number;
    validTo?: number;
    notes?: string[];
  };
  diagnostics?: {
    feeUsdWindow: number;
    windowSec: { fee: number; rewardSmoothingHalfLifeSec: number };
    tvlUsdTwab: number;
    rewardUsdPerSec: number;
    swapCount: number;
    coverageRatio: number;
  };
  /** below threshold: worker should avoid execution or blend fallback */
  usable: boolean;
}

export interface RobustYieldEngineResult {
  estimate: RobustYieldEstimate;
  rewardAprEwmNext: number | null;
  indexerCheckpointBlock: number;
}

export type FallbackMode = "off" | "api" | "auto";

export interface YieldEstimateRequest {
  chainId: number;
  poolAddress: string;
  gaugeAddress?: string;
  /** LP token address; if omitted, uses pool address (V2 pair = LP) */
  lpTokenAddress?: string;
  /** reward token override; else read from gauge */
  rewardTokenAddress?: string;
  feeWindowSec: number;
  /** max blocks to scan backward for logs from latest (RPC safety) */
  feeMaxBlocks: number;
  logChunkSize: number;
  poolFeeBps: number;
  rewardSmoothingHalfLifeSec: number;
  minExecutionConfidence: number;
  useForwardProjection: boolean;
  fallbackMode: FallbackMode;
  /** for API fallback — same as pool usually */
  apiPoolAddress?: string;
  aprFreshnessWindowSec: number;
  minApiConfidence: number;
  /** strategy capital delta for liquidity sensitivity (USD) */
  strategyDeltaUsd?: number;
  apyCompoundPeriodsPerYear?: number;
  /**
   * Optional DefiLlama direct-lookup hints.
   * When provided, the API fallback will attempt a token-based DefiLlama search
   * in addition to the Gecko / DexScreener consensus, improving fallback quality
   * for Aerodrome LP pools and Moonwell lending markets.
   */
  defiLlamaProject?: string;   // e.g. "aerodrome", "moonwell"
  defiLlamaToken0?: string;    // underlying token0 address
  defiLlamaToken1?: string;    // underlying token1 address (LP pools)
}

export interface YieldEngineContext {
  provider: JsonRpcProvider;
  /** last block fully scanned for fee logs (persist in worker state) */
  indexerCheckpointBlock?: number;
  /** previous EWMA reward APR (persist) */
  rewardAprEwmPrev?: number | null;
}

export interface FeeIndexResult {
  feeUsd: number;
  swapCount: number;
  fromBlock: number;
  toBlock: number;
  coverageRatio: number;
  windowSecActual: number;
  failedChunks: number;
  totalChunks: number;
}

export interface LiquiditySample {
  blockNumber: number;
  tvlUsd: number;
}

export interface RewardGaugeSnapshot {
  rewardRate: bigint;
  periodFinish: bigint;
  totalSupply: bigint;
  rewardToken: string;
  rewardUsdPerSec: number;
  stakedUsd: number;
  rewardAprInstant: number;
}
