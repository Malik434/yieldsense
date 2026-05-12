import { NextResponse } from 'next/server';
import { getState, getLogs } from '@/lib/stateStore';

const DEFAULT_STATE_RESPONSE = {
  previousApr: null,
  apiFailureStreak: 0,
  lastDecisionReason: null,
  lastRunAt: null,
  lastExecutionAt: null,
  suggestedNextCheckMs: 300_000,
  yieldIndexerCheckpointBlock: null,
  rewardAprEwm: null,
  defaultState: true,
  logs: [],
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get('userAddress') || '';
    const chainId = searchParams.get('chainId') || '';
    
    // ── Development Proxy Logic ──────────────────────────────────────────────
    // If running locally, attempt to fetch real data from production first.
    // This allows you to debug production logs on your local machine.
    if (process.env.NODE_ENV === 'development' && process.env.ENABLE_REMOTE_STATE_PROXY === 'true') {
      try {
        const remoteUrl = `https://yieldsense.huzaifamalik.tech/api/state?userAddress=${userAddress}&chainId=${chainId}`;
        const remoteRes = await fetch(remoteUrl, {
          next: { revalidate: 10 },
          signal: AbortSignal.timeout(2500),
        });
        if (remoteRes.ok) {
          const remoteData = await remoteRes.json();
          return NextResponse.json(remoteData);
        }
      } catch (e) {
        console.warn('[api/state] Remote proxy failed, falling back to local state:', e);
      }
    }

    const [state, logs] = await Promise.all([getState(userAddress, chainId), getLogs(userAddress, chainId)]);
    return NextResponse.json({ ...state, logs });
  } catch (error: unknown) {
    console.error('Error reading state:', error);
    return NextResponse.json(DEFAULT_STATE_RESPONSE);
  }
}
