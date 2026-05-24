import { NextResponse } from 'next/server';
import { loadProcessorRegistry } from '@/lib/processorRegistry';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const chainId = Number(searchParams.get('chainId') || '8453');
    const registry = await loadProcessorRegistry(chainId);

    if (!registry) {
      return NextResponse.json({ error: 'Executor registry is not configured' }, { status: 404 });
    }

    return NextResponse.json(registry);
  } catch (error: any) {
    console.error('[api/processors] Failed to load processor registry:', error);
    return NextResponse.json(
      { error: 'Failed to load processor registry', details: error.message },
      { status: 500 }
    );
  }
}
