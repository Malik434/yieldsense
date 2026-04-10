import axios from "axios";

const USER_AGENT = "YieldSense/3.0 (yield-engine)";

function parseGeckoTokenAddress(relationshipId: string): string {
  const i = relationshipId.lastIndexOf("_");
  return (i >= 0 ? relationshipId.slice(i + 1) : relationshipId).toLowerCase();
}

export function geckoNetworkForChainId(chainId: number): string {
  if (chainId === 8453) return "base";
  if (chainId === 84532) return "base-sepolia";
  return "base";
}

/**
 * Spot USD prices from GeckoTerminal pool detail (matches token0/token1 to base/quote).
 */
export async function fetchGeckoPoolSpotPricesUsd(
  poolAddress: string,
  networkSlug: string,
  token0: string,
  token1: string
): Promise<{ price0Usd: number; price1Usd: number } | null> {
  const addr = poolAddress.toLowerCase();
  const u0 = token0.toLowerCase();
  const u1 = token1.toLowerCase();
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${networkSlug}/pools/${addr}`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": USER_AGENT },
    });
    const data = res.data?.data;
    const baseId = data?.relationships?.base_token?.data?.id as string | undefined;
    const quoteId = data?.relationships?.quote_token?.data?.id as string | undefined;
    if (!data?.attributes || !baseId || !quoteId) return null;
    const baseAddr = parseGeckoTokenAddress(baseId);
    const quoteAddr = parseGeckoTokenAddress(quoteId);
    const pb = parseFloat(String(data.attributes.base_token_price_usd ?? ""));
    const pq = parseFloat(String(data.attributes.quote_token_price_usd ?? ""));
    if (!Number.isFinite(pb) || !Number.isFinite(pq) || pb <= 0 || pq <= 0) return null;
    if (u0 === baseAddr && u1 === quoteAddr) return { price0Usd: pb, price1Usd: pq };
    if (u0 === quoteAddr && u1 === baseAddr) return { price0Usd: pq, price1Usd: pb };
    return null;
  } catch {
    return null;
  }
}

/**
 * GeckoTerminal pool TVL (USD) — fallback when RPC cannot serve balanceOf / historical calls.
 * @param networkSlug e.g. "base" for Base mainnet
 */
export async function fetchGeckoPoolReserveUsd(
  poolAddress: string,
  networkSlug: string = "base"
): Promise<number> {
  const addr = poolAddress.toLowerCase();
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${networkSlug}/pools/${addr}`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": USER_AGENT },
    });
    const raw = res.data?.data?.attributes?.reserve_in_usd;
    if (raw == null) return 0;
    const n = parseFloat(String(raw));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
