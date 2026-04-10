import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import type { RewardGaugeSnapshot } from "../types.js";

const GAUGE_ABI = [
  "function rewardRate() view returns (uint256)",
  "function periodFinish() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function rewardToken() view returns (address)",
];

const ERC20_ABI = ["function decimals() view returns (uint8)"];

const SECONDS_PER_YEAR = 31_536_000;

export async function readGaugeSnapshot(
  provider: JsonRpcProvider,
  gaugeAddress: string,
  lpTokenAddress: string,
  lpTokenUsdPerToken: number,
  rewardTokenPriceUsd: number
): Promise<RewardGaugeSnapshot> {
  const gauge = new Contract(gaugeAddress, GAUGE_ABI, provider);
  const [rewardRate, periodFinish, totalSupply, rewardToken] = await Promise.all([
    gauge.rewardRate(),
    gauge.periodFinish(),
    gauge.totalSupply(),
    gauge.rewardToken(),
  ]);
  const rt = rewardToken as string;
  const rewardC = new Contract(rt, ERC20_ABI, provider);
  const lpC = new Contract(lpTokenAddress, ERC20_ABI, provider);
  const rewardDecimals = Number(await rewardDecimalsSafe(rewardC));
  const lpDecimals = Number(await rewardDecimalsSafe(lpC));

  const now = Math.floor(Date.now() / 1000);
  const active = Number(periodFinish) > now && rewardRate > 0n;
  const rr = active ? Number(formatUnits(rewardRate, rewardDecimals)) : 0;
  const rewardUsdPerSec = rr * rewardTokenPriceUsd;

  const supplyHuman = Number(formatUnits(totalSupply as bigint, lpDecimals));
  const stakedUsd = supplyHuman * lpTokenUsdPerToken;

  const rewardAprInstant =
    stakedUsd > 0 && active ? (rewardUsdPerSec * SECONDS_PER_YEAR) / stakedUsd : 0;

  return {
    rewardRate: rewardRate as bigint,
    periodFinish: periodFinish as bigint,
    totalSupply: totalSupply as bigint,
    rewardToken: rt,
    rewardUsdPerSec,
    stakedUsd,
    rewardAprInstant,
  };
}

async function rewardDecimalsSafe(c: Contract): Promise<number> {
  try {
    return Number(await c.decimals());
  } catch {
    return 18;
  }
}
