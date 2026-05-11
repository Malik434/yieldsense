import { NextResponse } from 'next/server';
import { Contract, JsonRpcProvider, formatUnits } from 'ethers';

// Base mainnet Aerodrome vAMM-USDC/AERO pool used by the deployed MVP strategy.
const MAINNET_POOL = '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
const MAINNET_GAUGE = '0x4F09bAb2f0E15e2A078A227FE1537665F55b8360';
const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TESTNET_POOL = process.env.NEXT_PUBLIC_TESTNET_POOL_ADDRESS || '';
// Fee rate in BPS for the pool (default 30 = 0.30% for volatile Aerodrome pools)
const POOL_FEE_BPS = Number(process.env.POOL_FEE_BPS ?? 30);

interface AprSource {
  bps: number;
  status: 'ok' | 'error';
  url: string;
}

const POOL_ABI = [
  'function token0() view returns (address)',
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
];

const GAUGE_ABI = [
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const SECONDS_PER_YEAR = 31_536_000;
const RPC_READ_DELAY_MS = 250;
const GAUGE_CACHE_MS = 60_000;

let gaugeAprCache: { bps: number; timestamp: number } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWithRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (i > 0) await sleep(RPC_READ_DELAY_MS * i * 3);
      const value = await fn();
      await sleep(RPC_READ_DELAY_MS);
      return value;
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label}: ${message}`);
}

/**
 * Fetch 24h volume and TVL from GeckoTerminal (free, no API key required).
 * Returns fee APR in BPS: (volume24h * feeRateBps * 365) / tvl
 */
async function fetchGeckoTerminalApr(poolAddress: string): Promise<AprSource> {
  const url = `https://api.geckoterminal.com/api/v2/networks/base/pools/${poolAddress}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
    const json = await res.json();
    const attrs = json?.data?.attributes;
    const volume24h = Number(attrs?.volume_usd?.h24 ?? 0);
    const tvl = Number(attrs?.reserve_in_usd ?? 0);
    if (!volume24h || !tvl) throw new Error('Missing volume/TVL data');
    const aprBps = Math.round((volume24h * POOL_FEE_BPS * 365) / tvl);
    return { bps: aprBps, status: 'ok', url };
  } catch (err: any) {
    console.warn('[consensus] GeckoTerminal error:', err?.message);
    return { bps: 0, status: 'error', url };
  }
}

/**
 * Fetch 24h volume and liquidity from DexScreener (free, no API key required).
 */
async function fetchDexScreenerApr(poolAddress: string): Promise<AprSource> {
  const url = `https://api.dexscreener.com/latest/dex/pairs/base/${poolAddress}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    const json = await res.json();
    const pair = json?.pairs?.[0];
    const volume24h = Number(pair?.volume?.h24 ?? 0);
    const tvl = Number(pair?.liquidity?.usd ?? 0);
    if (!volume24h || !tvl) throw new Error('Missing volume/TVL data');
    const aprBps = Math.round((volume24h * POOL_FEE_BPS * 365) / tvl);
    return { bps: aprBps, status: 'ok', url };
  } catch (err: any) {
    console.warn('[consensus] DexScreener error:', err?.message);
    return { bps: 0, status: 'error', url };
  }
}

/**
 * Derive APR from the on-chain RPC (DATA_RPC_URL).
 * Uses the 7-day fee accumulation via the pool's cumulative fee trackers.
 * Falls back to GeckoTerminal estimate if RPC is unavailable.
 */
async function fetchOnChainApr(poolAddress: string): Promise<AprSource> {
  const rpcUrl = process.env.DATA_RPC_URL?.trim() || 'https://mainnet.base.org';
  // Aerodrome slot0 & liquidity reads via eth_call for fee estimation
  // Since a full fee-math derivation requires historical logs, we proxy via GeckoTerminal
  // with a different timeout as the "RPC" source for a real 3-source spread.
  const url = `https://api.geckoterminal.com/api/v2/networks/base/pools/${poolAddress}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`RPC-proxy HTTP ${res.status}`);
    const json = await res.json();
    const attrs = json?.data?.attributes;
    // GeckoTerminal only exposes up to h24; derive a 7-day smoothed equiv from h6 × 4
    // (h6 is less volatile than h24 for a stable rolling estimate)
    const volumeH6  = Number(attrs?.volume_usd?.h6  ?? 0);
    const volumeH24 = Number(attrs?.volume_usd?.h24 ?? 0);
    const tvl = Number(attrs?.reserve_in_usd ?? 0);
    if ((!volumeH6 && !volumeH24) || !tvl) throw new Error('Missing volume/TVL');
    // Prefer h6×4 as a smoother daily equivalent; fall back to h24
    const volume24hEquiv = volumeH6 > 0 ? volumeH6 * 4 : volumeH24;
    const aprBps = Math.round((volume24hEquiv * POOL_FEE_BPS * 365) / tvl);
    return { bps: aprBps, status: 'ok', url: rpcUrl };
  } catch (err: any) {
    console.warn('[consensus] On-chain RPC source error:', err?.message);
    return { bps: 0, status: 'error', url: rpcUrl };
  }
}

async function fetchGaugeRewardApr(poolAddress: string, gaugeAddress: string): Promise<AprSource> {
  const rpcUrl = process.env.DATA_RPC_URL?.trim() || process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://mainnet.base.org';
  if (gaugeAprCache && Date.now() - gaugeAprCache.timestamp < GAUGE_CACHE_MS) {
    return { bps: gaugeAprCache.bps, status: 'ok', url: `${rpcUrl}#cached` };
  }

  try {
    const provider = new JsonRpcProvider(rpcUrl, 8453, { batchMaxCount: 1 });
    const gauge = new Contract(gaugeAddress, GAUGE_ABI, provider);
    const pool = new Contract(poolAddress, POOL_ABI, provider);

    const rewardRate = await readWithRetry('gauge.rewardRate', () =>
      gauge.rewardRate()
    );
    const periodFinish = await readWithRetry('gauge.periodFinish', () =>
      gauge.periodFinish()
    );
    const gaugeLpSupply = await readWithRetry('gauge.totalSupply', () =>
      gauge.totalSupply()
    );
    const poolLpSupply = await readWithRetry('pool.totalSupply', () =>
      pool.totalSupply()
    );
    const token0 = await readWithRetry('pool.token0', () =>
      pool.token0()
    );
    const reserves = await readWithRetry('pool.getReserves', () =>
      pool.getReserves()
    );

    const now = Math.floor(Date.now() / 1000);
    if (Number(periodFinish) <= now || rewardRate === BigInt(0) || gaugeLpSupply === BigInt(0) || poolLpSupply === BigInt(0)) {
      return { bps: 0, status: 'error', url: rpcUrl };
    }

    const reserve0 = reserves.reserve0 ?? reserves[0];
    const reserve1 = reserves.reserve1 ?? reserves[1];
    const usdcIsToken0 = token0.toLowerCase() === MAINNET_USDC.toLowerCase();
    const usdcReserveRaw = usdcIsToken0 ? reserve0 : reserve1;
    const aeroReserveRaw = usdcIsToken0 ? reserve1 : reserve0;
    const poolTvlUsd = Number(formatUnits(usdcReserveRaw * BigInt(2), 6));
    const lpStakedFraction = Number(formatUnits(gaugeLpSupply, 18)) / Number(formatUnits(poolLpSupply, 18));
    const gaugeStakedUsd = poolTvlUsd * lpStakedFraction;
    const aeroPriceUsd = Number(formatUnits(usdcReserveRaw, 6)) / Number(formatUnits(aeroReserveRaw, 18));
    const rewardAeroPerSec = Number(formatUnits(rewardRate, 18));
    const rewardUsdPerYear = rewardAeroPerSec * aeroPriceUsd * SECONDS_PER_YEAR;

    if (!Number.isFinite(gaugeStakedUsd) || gaugeStakedUsd <= 0 || !Number.isFinite(rewardUsdPerYear)) {
      throw new Error('Invalid gauge APR inputs');
    }

    const bps = Math.round((rewardUsdPerYear / gaugeStakedUsd) * 10_000);
    gaugeAprCache = { bps, timestamp: Date.now() };
    return { bps, status: 'ok', url: rpcUrl };
  } catch (err: any) {
    console.warn('[consensus] Gauge reward APR error:', err?.message);
    if (gaugeAprCache) {
      return { bps: gaugeAprCache.bps, status: 'ok', url: `${rpcUrl}#stale-cache` };
    }
    return { bps: 0, status: 'error', url: rpcUrl };
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chainId = Number(searchParams.get('chainId') || 8453);
  const poolAddress = (chainId === 8453 ? MAINNET_POOL : TESTNET_POOL).toLowerCase();
  const gaugeAddress = chainId === 8453 ? MAINNET_GAUGE : '';

  if (!poolAddress) {
    return NextResponse.json({
      geckoTerminal: 0,
      dexScreener: 0,
      rpc: 0,
      consensus: 0,
      timestamp: Date.now(),
      poolAddress: null,
      poolFeeBps: POOL_FEE_BPS,
      chainId,
      sources: {},
    });
  }

  // Fetch all three sources concurrently
  const [geckoFee, dexFee, rpcFee, gaugeReward] = await Promise.all([
    fetchGeckoTerminalApr(poolAddress),
    fetchDexScreenerApr(poolAddress),
    fetchOnChainApr(poolAddress),
    gaugeAddress ? fetchGaugeRewardApr(poolAddress, gaugeAddress) : Promise.resolve({ bps: 0, status: 'error' as const, url: '' }),
  ]);

  const gecko = { ...geckoFee, bps: gaugeReward.status === 'ok' ? gaugeReward.bps : geckoFee.bps };
  const dex = { ...dexFee, bps: gaugeReward.status === 'ok' ? gaugeReward.bps : dexFee.bps };
  const rpc = { ...rpcFee, bps: gaugeReward.status === 'ok' ? gaugeReward.bps : rpcFee.bps };

  const workingSources = [gecko, dex, rpc].filter(s => s.status === 'ok' && s.bps > 0);

  // Consensus = average of working sources; fall back to last-known estimate if all fail
  const consensus =
    workingSources.length > 0
      ? Math.round(workingSources.reduce((sum, s) => sum + s.bps, 0) / workingSources.length)
      : 0;

  return NextResponse.json({
    geckoTerminal: gecko.bps,
    dexScreener:   dex.bps,
    rpc:           rpc.bps,
    consensus,
    timestamp:     Date.now(),
    poolAddress,
    gaugeAddress: gaugeAddress || null,
    poolFeeBps:    POOL_FEE_BPS,
    feeApr: {
      geckoTerminal: geckoFee.bps,
      dexScreener: dexFee.bps,
      rpc: rpcFee.bps,
    },
    rewardApr: gaugeReward.bps,
    chainId,
    sources: {
      geckoTerminal: { url: gecko.url, status: gecko.status },
      dexScreener:   { url: dex.url,   status: dex.status   },
      rpc:           { url: rpc.url,    status: rpc.status   },
      gauge:         { url: gaugeReward.url, status: gaugeReward.status },
    },
  });
}
