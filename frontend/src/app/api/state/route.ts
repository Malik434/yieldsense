import { NextResponse } from 'next/server';
import { getState, getLogs } from '@/lib/stateStore';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get('userAddress') || '';
    
    // ── Development Proxy Logic ──────────────────────────────────────────────
    // If running locally, attempt to fetch real data from production first.
    // This allows you to debug production logs on your local machine.
    if (process.env.NODE_ENV === 'development') {
      try {
        const remoteUrl = `https://yieldsense.huzaifamalik.tech/api/state?userAddress=${userAddress}`;
        const remoteRes = await fetch(remoteUrl, { next: { revalidate: 10 } });
        if (remoteRes.ok) {
          const remoteData = await remoteRes.json();
          return NextResponse.json(remoteData);
        }
      } catch (e) {
        console.warn('[api/state] Remote proxy failed, falling back to local state:', e);
      }
    }

    const [state, logs] = await Promise.all([getState(userAddress), getLogs(userAddress)]);
    return NextResponse.json({ ...state, logs });
  } catch (error: any) {
    console.error('Error reading state:', error);
    return NextResponse.json(
      { error: 'Failed to read state', details: error.message, defaultState: true },
      { status: 500 }
    );
  }
}
