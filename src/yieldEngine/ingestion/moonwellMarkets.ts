import { ethers } from "ethers";

/**
 * Moonwell market yield data fetched directly from on-chain mToken contracts.
 * No SDK dependency — uses Moonwell's Compound V2 fork ABI calls.
 *
 * All liquidity values (totalSupplyUnderlying, totalBorrows) are in
 * human-readable underlying token units (e.g. USDC units for mUSDC).
 */
export interface MoonwellMarketData {
  marketAddress: string;
  label: string;
  /** Underlying ERC-20 address (null for native-ETH markets) */
  underlyingAddress: string | null;
  /** Underlying token decimals used for scaling */
  underlyingDecimals: number;
  supplyApyPercent: number;
  borrowApyPercent: number;
  /** Total supply in human-readable underlying units (cash + borrows) */
  totalSupplyUnderlying: number;
  /** Total borrows in human-readable underlying units */
  totalBorrows: number;
  utilizationPercent: number;
}

const MTOKEN_ABI = [
  "function supplyRatePerTimestamp() view returns (uint256)",
  "function borrowRatePerTimestamp() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function underlying() view returns (address)",
];

const ERC20_ABI = ["function decimals() view returns (uint8)"];

// Verified Moonwell mToken addresses on Base mainnet (as of 2024-Q4)
export const MOONWELL_MARKETS_BASE: Record<string, string> = {
  "mUSDC":   "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
  "mWETH":   "0x628ff693426583D9a7FB391E54366292F509D457",
  "mcbETH":  "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5",
  "mDAI":    "0x73b06D8d18De422E269645eaCe15400DE7462417",
  "mUSDbC":  "0x703843C3379b52F9FF486c9f5892218d2a065cC8",
  "mwstETH": "0x627Fe393Bc6EdDA28e99AE595F3bc7dE2bCD21d1",
  "mrETH":   "0xCB1DaCd30638ae38F2B94eA64F066045B7D45f44",
  "mAERO":   "0xA88594D404727625A9437C3f886C7643872296AE",
};

// 365.25 days × 24h × 3600s — matches Moonwell's own APY calculator
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/**
 * Safely fetch the decimals of the underlying ERC-20 token.
 * Returns 18 if the call fails (e.g. native-ETH market).
 */
async function getUnderlyingDecimals(
  provider: ethers.JsonRpcProvider,
  mToken: ethers.Contract
): Promise<{ underlyingAddress: string | null; decimals: number }> {
  try {
    const underlyingAddr: string = await mToken.underlying();
    const underlyingContract = new ethers.Contract(underlyingAddr, ERC20_ABI, provider);
    const dec = Number(await underlyingContract.decimals());
    return { underlyingAddress: underlyingAddr, decimals: Number.isFinite(dec) && dec > 0 ? dec : 18 };
  } catch {
    // Native-ETH markets (CEther pattern) don't have underlying(); default 18
    return { underlyingAddress: null, decimals: 18 };
  }
}

/**
 * Fetch yield data for a single Moonwell market.
 */
async function fetchMarketData(
  provider: ethers.JsonRpcProvider,
  marketAddress: string,
  label: string
): Promise<MoonwellMarketData | null> {
  try {
    const addr = ethers.getAddress(marketAddress);
    const mToken = new ethers.Contract(addr, MTOKEN_ABI, provider);

    // Run all RPC calls concurrently; underlying decimals need the address first
    const [supplyRate, borrowRate, totalBorrowsRaw, cashRaw, { underlyingAddress, decimals: underlyingDecimals }] =
      await Promise.all([
        mToken.supplyRatePerTimestamp(),
        mToken.borrowRatePerTimestamp(),
        mToken.totalBorrows(),
        mToken.getCash(),
        getUnderlyingDecimals(provider, mToken),
      ]);

    // Supply/borrow rates are 1e18-scaled per-second interest rates → compound to annual APY
    const supplyRatePerSec = Number(supplyRate) / 1e18;
    const borrowRatePerSec = Number(borrowRate) / 1e18;
    const supplyApyPercent = (Math.pow(1 + supplyRatePerSec, SECONDS_PER_YEAR) - 1) * 100;
    const borrowApyPercent = (Math.pow(1 + borrowRatePerSec, SECONDS_PER_YEAR) - 1) * 100;

    // getCash() and totalBorrows() are denominated in underlying token units
    // (e.g. 6-decimal USDC, 18-decimal WETH). Divide by 10^decimals for human values.
    const scale = 10 ** underlyingDecimals;
    const totalBorrowsHuman = Number(totalBorrowsRaw) / scale;
    const cashHuman = Number(cashRaw) / scale;
    const totalSupplyHuman = cashHuman + totalBorrowsHuman;
    const utilizationPercent =
      totalSupplyHuman > 0 ? (totalBorrowsHuman / totalSupplyHuman) * 100 : 0;

    return {
      marketAddress: addr,
      label,
      underlyingAddress,
      underlyingDecimals,
      supplyApyPercent,
      borrowApyPercent,
      totalSupplyUnderlying: totalSupplyHuman,
      totalBorrows: totalBorrowsHuman,
      utilizationPercent,
    };
  } catch (e: any) {
    console.error(`  ⚠ ${label}: ${e.message?.slice(0, 120)}`);
    return null;
  }
}

/**
 * Fetch yield data for all well-known Moonwell markets on Base.
 *
 * @param provider Base mainnet JSON-RPC provider
 * @param markets  Optional override map { label → address }; defaults to MOONWELL_MARKETS_BASE
 */
export async function fetchAllMoonwellMarkets(
  provider: ethers.JsonRpcProvider,
  markets?: Record<string, string>
): Promise<MoonwellMarketData[]> {
  const marketMap = markets ?? MOONWELL_MARKETS_BASE;
  const entries = Object.entries(marketMap);

  const results = await Promise.allSettled(
    entries.map(([label, addr]) => fetchMarketData(provider, addr, label))
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<MoonwellMarketData | null> =>
        r.status === "fulfilled"
    )
    .map((r) => r.value)
    .filter((r): r is MoonwellMarketData => r !== null);
}
