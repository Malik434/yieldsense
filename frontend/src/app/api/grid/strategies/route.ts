import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { gridStore, loadGridPairs, toLiveGridConfig, type StoredGridStrategy } from '@/lib/gridStore';

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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const owner = searchParams.get('owner')?.toLowerCase();
  const status = searchParams.get('status');
  const chainId = Number(searchParams.get('chainId') || '8453');
  const mode = searchParams.get('mode');
  const pairs = new Map(loadGridPairs(chainId).map((pair) => [pair.pairId, pair]));

  const strategies = Array.from(gridStore.strategies.values()).filter((strategy) => {
    if (strategy.chainId !== chainId) return false;
    if (owner && strategy.owner.toLowerCase() !== owner) return false;
    if (status && strategy.status !== status) return false;
    return true;
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
  const existing = gridStore.strategies.get(strategy.strategyId);
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

  gridStore.strategies.set(record.strategyId, record);
  return NextResponse.json({ strategy: record });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  const { strategyId, status } = body as { strategyId?: string; status?: StoredGridStrategy['status'] };
  if (!strategyId || !validStatus(status)) return NextResponse.json({ error: 'Invalid strategyId or status' }, { status: 400 });

  const existing = gridStore.strategies.get(strategyId);
  if (!existing) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });

  const updated = { ...existing, status, updatedAt: new Date().toISOString() };
  gridStore.strategies.set(strategyId, updated);
  return NextResponse.json({ strategy: updated });
}
