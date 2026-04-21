import { NextResponse } from 'next/server';

// Consensus APR from 3 sources in basis points (100 = 1%)
// In production, these would be live fetches from:
// - GeckoTerminal USDC/ETH pool APR
// - DexScreener aggregated fee APR
// - On-chain RPC computation (Aerodrome/Moonwell blended)
export async function GET() {
  // Simulated small variance between sources, reflecting real-world oracle divergence
  const base = 1820; // ~18.20% consensus
  const geckoTerminal = base + Math.floor((Math.random() - 0.5) * 120);
  const dexScreener = base + Math.floor((Math.random() - 0.5) * 80);
  const rpc = base + Math.floor((Math.random() - 0.5) * 60);
  const consensus = Math.round((geckoTerminal + dexScreener + rpc) / 3);

  return NextResponse.json({
    geckoTerminal,
    dexScreener,
    rpc,
    consensus,
    timestamp: Date.now(),
    sources: {
      geckoTerminal: { url: 'https://api.geckoterminal.com/api/v2', status: 'ok' },
      dexScreener: { url: 'https://api.dexscreener.com/latest', status: 'ok' },
      rpc: { url: 'https://mainnet.base.org', status: 'ok' },
    },
  });
}
