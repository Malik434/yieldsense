import { NextRequest, NextResponse } from 'next/server';
import { reconcileGridProcessorLease } from '@/lib/gridProcessorOrchestrator';

function isAuthorized(request: NextRequest) {
  const secret = process.env.GRID_ORCHESTRATOR_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === 'development') return true;
  if (!secret) return false;

  const authHeader = request.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  return token === secret;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const chainId = Number(body.chainId || 8453);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: 'Invalid chainId' }, { status: 400 });
  }

  const result = await reconcileGridProcessorLease(chainId);
  return NextResponse.json(result);
}
