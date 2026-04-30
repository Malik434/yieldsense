import { NextResponse } from 'next/server';
import { getState, getLogs } from '@/lib/stateStore';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get('userAddress') || undefined;

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
