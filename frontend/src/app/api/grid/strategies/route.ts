import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { loadGridPairs, toLiveGridConfig, type StoredGridStrategy } from '@/lib/gridStore';
import {
  listGridStrategies,
  patchGridStrategyStatus,
  upsertGridStrategy,
} from '@/lib/gridStrategyRepository';
import { reconcileGridProcessorLease } from '@/lib/gridProcessorOrchestrator';

function validStatus(status: unknown): status is StoredGridStrategy['status'] {
  return typeof status === 'string' && ['draft', 'funded', 'active', 'paused', 'gas_paused', 'archived', 'closed'].includes(status);
}

function validGridMode(mode: unknown): mode is StoredGridStrategy['gridMode'] {
  return mode === 'arithmetic' || mode === 'geometric';
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function wakeGridOrchestrator(chainId: number) {
  try {
    await reconcileGridProcessorLease(chainId);
  } catch (error) {
    console.error('[grid-strategies] Failed to wake grid orchestrator:', error);
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const owner = searchParams.get('owner')?.toLowerCase();
  const status = searchParams.get('status');
  const chainId = Number(searchParams.get('chainId') || '8453');
  const mode = searchParams.get('mode');
  const pairs = new Map(loadGridPairs(chainId).map((pair) => [pair.pairId, pair]));

  const strategies = await listGridStrategies({
    chainId,
    owner,
    status,
  });

  if (mode === 'processor') {
    return NextResponse.json({
      strategies: strategies
        .map((strategy) => {
          const pair = pairs.get(strategy.pairId);
          return pair ? toLiveGridConfig(strategy, pair) : null;
        })
        .filter(Boolean),
    });
  }

  return NextResponse.json({ strategies });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const strategy = body as Partial<StoredGridStrategy>;
  if (!strategy.strategyId || !strategy.owner || !isAddress(strategy.owner) || !strategy.pairId) {
    return NextResponse.json({ error: 'Missing strategyId, owner, or pairId' }, { status: 400 });
  }
  if (!validStatus(strategy.status)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 });

  const now = new Date().toISOString();
  const existing = (await listGridStrategies({ chainId: Number(strategy.chainId || 8453) }))
    .find((item) => item.strategyId === strategy.strategyId);
  const record: StoredGridStrategy = {
    strategyId: strategy.strategyId,
    owner: strategy.owner,
    chainId: Number(strategy.chainId || 8453),
    pairId: strategy.pairId,
    status: strategy.status,
    lowerPrice: Number(strategy.lowerPrice),
    upperPrice: Number(strategy.upperPrice),
    gridMode: validGridMode(strategy.gridMode) ? strategy.gridMode : 'arithmetic',
    gridCount: Number(strategy.gridCount),
    tradeSizeQuote: String(strategy.tradeSizeQuote || '0'),
    triggerPrice: optionalNumber(strategy.triggerPrice),
    stopLossPrice: optionalNumber(strategy.stopLossPrice),
    takeProfitPrice: optionalNumber(strategy.takeProfitPrice),
    maxSlippageBps: Number(strategy.maxSlippageBps || 100),
    executionIntervalSec: Number(strategy.executionIntervalSec || 3600),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await upsertGridStrategy(record);
  await wakeGridOrchestrator(record.chainId);
  return NextResponse.json({ strategy: record });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  const { strategyId, status, chainId: bodyChainId } = body as {
    strategyId?: string;
    status?: StoredGridStrategy['status'];
    chainId?: number;
  };
  if (!strategyId || !validStatus(status)) return NextResponse.json({ error: 'Invalid strategyId or status' }, { status: 400 });

  const chainId = Number(bodyChainId || 8453);
  const updated = await patchGridStrategyStatus(chainId, strategyId, status);
  if (!updated) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });

  await wakeGridOrchestrator(chainId);
  return NextResponse.json({ strategy: updated });
}
