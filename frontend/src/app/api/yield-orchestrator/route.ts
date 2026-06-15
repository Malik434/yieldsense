import { NextRequest, NextResponse } from 'next/server';
import {
  reconcileYieldProcessorLease,
  setYieldProcessorOrchestrationEnabled,
} from '@/lib/yieldProcessorOrchestrator';
import { getYieldProcessorLease } from '@/lib/yieldProcessorLeaseRepository';

function chainIdFromRequest(request: NextRequest) {
  return Number(new URL(request.url).searchParams.get('chainId') || '8453');
}

export async function GET(request: NextRequest) {
  const chainId = chainIdFromRequest(request);
  const lease = await getYieldProcessorLease(chainId);
  return NextResponse.json({ lease });
}

export async function PATCH(request: NextRequest) {
  const chainId = chainIdFromRequest(request);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'Body must include boolean enabled.' }, { status: 400 });
  }

  const lease = await setYieldProcessorOrchestrationEnabled(chainId, body.enabled);
  const result = body.enabled
    ? await reconcileYieldProcessorLease(chainId)
    : { lease, action: 'disabled' as const };
  return NextResponse.json(result);
}
