import { NextResponse } from 'next/server';
import { loadOnchainAudit } from '@/lib/onchainAudit';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get('userAddress') || '';
    const chainId = Number(searchParams.get('chainId') || '8453');
    const audit = await loadOnchainAudit(userAddress, chainId);

    if (!audit) {
      return NextResponse.json({ error: 'Invalid audit request' }, { status: 400 });
    }

    return NextResponse.json(audit);
  } catch (error: any) {
    console.error('[api/onchain-audit] Failed to load on-chain audit:', error);
    return NextResponse.json(
      { error: 'Failed to load on-chain audit', details: error.message },
      { status: 500 }
    );
  }
}
