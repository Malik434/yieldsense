import { isAddress, keccak256, stringToBytes } from 'viem';
import type { HexAddress } from './gridTypes';

export type GridPairConfig = {
  pairId: string;
  label: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseToken: HexAddress;
  quoteToken: HexAddress;
  poolAddress: HexAddress;
  dexRouter: HexAddress;
  factory: HexAddress;
  stable: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  enabled: boolean;
};

export type StoredGridStrategy = {
  strategyId: string;
  owner: HexAddress;
  chainId: number;
  pairId: string;
  status: 'draft' | 'funded' | 'active' | 'paused' | 'gas_paused' | 'archived' | 'closed';
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  tradeSizeQuote: string;
  maxSlippageBps: number;
  executionIntervalSec: number;
  createdAt: string;
  updatedAt: string;
};

type GridStore = {
  strategies: Map<string, StoredGridStrategy>;
};

const globalForGridStore = globalThis as typeof globalThis & {
  __yieldsenseGridStore?: GridStore;
};

export const gridStore: GridStore =
  globalForGridStore.__yieldsenseGridStore ||
  (globalForGridStore.__yieldsenseGridStore = {
    strategies: new Map(),
  });

const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const MAINNET_AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as const;
const MAINNET_WETH = '0x4200000000000000000000000000000000000006' as const;
const MAINNET_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as const;
const MAINNET_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as const;
const MAINNET_AERO_USDC_POOL = '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d' as const;
const MAINNET_ETH_USDC_PRICE_POOL = '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59' as const;

function pairId(label: string) {
  return keccak256(stringToBytes(label));
}

function envAddress(value: string | undefined): HexAddress | null {
  const trimmed = value?.trim();
  return trimmed && isAddress(trimmed) ? trimmed : null;
}

export function loadGridPairs(chainId: number): GridPairConfig[] {
  if (chainId !== 8453) {
    return [
      {
        pairId: pairId('AERO-USDC'),
        label: 'AERO/USDC',
        baseSymbol: 'AERO',
        quoteSymbol: 'USDC',
        baseToken: (process.env.NEXT_PUBLIC_TESTNET_REWARD_TOKEN_ADDRESS || MAINNET_AERO) as HexAddress,
        quoteToken: (process.env.NEXT_PUBLIC_TESTNET_ASSET_ADDRESS || MAINNET_USDC) as HexAddress,
        poolAddress: (process.env.NEXT_PUBLIC_TESTNET_POOL_ADDRESS || '0x0000000000000000000000000000000000000000') as HexAddress,
        dexRouter: (process.env.NEXT_PUBLIC_TESTNET_ROUTER_ADDRESS || MAINNET_ROUTER) as HexAddress,
        factory: (process.env.NEXT_PUBLIC_TESTNET_FACTORY_ADDRESS || MAINNET_FACTORY) as HexAddress,
        stable: false,
        baseDecimals: 18,
        quoteDecimals: 6,
        enabled: true,
      },
    ];
  }

  const pairs: GridPairConfig[] = [
    {
      pairId: pairId('AERO-USDC'),
      label: 'AERO/USDC',
      baseSymbol: 'AERO',
      quoteSymbol: 'USDC',
      baseToken: MAINNET_AERO,
      quoteToken: MAINNET_USDC,
      poolAddress: envAddress(process.env.NEXT_PUBLIC_AERO_USDC_POOL_ADDRESS) ?? MAINNET_AERO_USDC_POOL,
      dexRouter: MAINNET_ROUTER,
      factory: MAINNET_FACTORY,
      stable: false,
      baseDecimals: 18,
      quoteDecimals: 6,
      enabled: true,
    },
    {
      pairId: pairId('ETH-USDC'),
      label: 'ETH/USDC',
      baseSymbol: 'ETH',
      quoteSymbol: 'USDC',
      baseToken: MAINNET_WETH,
      quoteToken: MAINNET_USDC,
      poolAddress:
        envAddress(process.env.NEXT_PUBLIC_ETH_USDC_GRID_POOL_ADDRESS) ??
        envAddress(process.env.NEXT_PUBLIC_ETH_USDC_POOL_ADDRESS) ??
        envAddress(process.env.NEXT_PUBLIC_UNISWAP_POOL_ADDRESS) ??
        MAINNET_ETH_USDC_PRICE_POOL,
      dexRouter: MAINNET_ROUTER,
      factory: MAINNET_FACTORY,
      stable: false,
      baseDecimals: 18,
      quoteDecimals: 6,
      enabled: true,
    },
  ];

  const acuToken = envAddress(process.env.NEXT_PUBLIC_ACU_TOKEN_ADDRESS);
  const acuPool = envAddress(process.env.NEXT_PUBLIC_ACU_USDC_POOL_ADDRESS);
  if (acuToken && acuPool) {
    pairs.push({
      pairId: pairId('ACU-USDC'),
      label: 'ACU/USDC',
      baseSymbol: 'ACU',
      quoteSymbol: 'USDC',
      baseToken: acuToken,
      quoteToken: MAINNET_USDC,
      poolAddress: acuPool,
      dexRouter: MAINNET_ROUTER,
      factory: MAINNET_FACTORY,
      stable: process.env.NEXT_PUBLIC_ACU_USDC_STABLE === 'true',
      baseDecimals: Number(process.env.NEXT_PUBLIC_ACU_DECIMALS || '18'),
      quoteDecimals: 6,
      enabled: true,
    });
  }

  return pairs.filter((pair) => pair.enabled);
}

export function toLiveGridConfig(strategy: StoredGridStrategy, pair: GridPairConfig) {
  return {
    strategyId: strategy.strategyId,
    pairId: strategy.pairId,
    poolAddress: pair.poolAddress,
    dexRouter: pair.dexRouter,
    factory: pair.factory,
    stable: pair.stable,
    lowerPrice: strategy.lowerPrice,
    upperPrice: strategy.upperPrice,
    gridCount: strategy.gridCount,
    tradeSizeQuote: strategy.tradeSizeQuote,
    maxSlippageBps: strategy.maxSlippageBps,
    executionIntervalSec: strategy.executionIntervalSec,
    quoteDecimals: pair.quoteDecimals,
    baseDecimals: pair.baseDecimals,
  };
}
