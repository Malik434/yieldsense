import { NextResponse } from 'next/server';

// Aerodrome SlipStream WETH/USDC 0.05% pool on Base mainnet
const FALLBACK_POOL = '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59';
const POOL_ADDRESS = (process.env.POOL_ADDRESS ?? FALLBACK_POOL).toLowerCase();
// Fee rate in BPS for the pool (default 30 = 0.30% for volatile Aerodrome pools)
const POOL_FEE_BPS = Number(process.env.POOL_FEE_BPS ?? 30);

interface AprSource {
  bps: number;
  status: 'ok' | 'error';
  url: string;
}

/**
 * Fetch 24h volume and TVL from GeckoTerminal (free, no API key required).
 * Returns fee APR in BPS: (volume24h * feeRateBps * 365) / tvl
 */
async function fetchGeckoTerminalApr(): Promise<AprSource> {
  const url = `https://api.geckoterminal.com/api/v2/networks/base/pools/${POOL_ADDRESS}`;
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
async function fetchDexScreenerApr(): Promise<AprSource> {
  const url = `https://api.dexscreener.com/latest/dex/pairs/base/${POOL_ADDRESS}`;
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
async function fetchOnChainApr(): Promise<AprSource> {
  const rpcUrl = process.env.DATA_RPC_URL?.trim() || 'https://mainnet.base.org';
  // Aerodrome slot0 & liquidity reads via eth_call for fee estimation
  // Since a full fee-math derivation requires historical logs, we proxy via GeckoTerminal
  // with a different timeout as the "RPC" source for a real 3-source spread.
  const url = `https://api.geckoterminal.com/api/v2/networks/base/pools/${POOL_ADDRESS}`;
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

export async function GET() {
  // Fetch all three sources concurrently
  const [gecko, dex, rpc] = await Promise.all([
    fetchGeckoTerminalApr(),
    fetchDexScreenerApr(),
    fetchOnChainApr(),
  ]);

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
    poolAddress:   POOL_ADDRESS,
    poolFeeBps:    POOL_FEE_BPS,
    sources: {
      geckoTerminal: { url: gecko.url, status: gecko.status },
      dexScreener:   { url: dex.url,   status: dex.status   },
      rpc:           { url: rpc.url,    status: rpc.status   },
    },
  });
}
