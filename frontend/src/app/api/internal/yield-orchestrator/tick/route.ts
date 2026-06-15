import { NextRequest, NextResponse } from 'next/server';
import { reconcileYieldProcessorLease } from '@/lib/yieldProcessorOrchestrator';

function isAuthorized(request: NextRequest) {
  const secret = process.env.GRID_ORCHESTRATOR_SECRET || process.env.YIELD_ORCHESTRATOR_SECRET;
  if (!secret) return process.env.NODE_ENV === 'development';
  const header = request.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const chainId = Number(searchParams.get('chainId') || '8453');
  const result = await reconcileYieldProcessorLease(chainId);
  return NextResponse.json(result);
}
