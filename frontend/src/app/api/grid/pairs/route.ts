import { NextRequest, NextResponse } from 'next/server';
import { loadGridPairs } from '@/lib/gridStore';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const chainId = Number(searchParams.get('chainId') || '8453');
  return NextResponse.json({ pairs: loadGridPairs(chainId).filter((pair) => pair.enabled) });
}
