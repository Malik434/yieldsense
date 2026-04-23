import { NextResponse } from 'next/server';
import { getState, getLogs } from '@/lib/stateStore';

export async function GET() {
  try {
    const [state, logs] = await Promise.all([getState(), getLogs()]);
    return NextResponse.json({ ...state, logs });
  } catch (error: any) {
    console.error('Error reading state:', error);
    return NextResponse.json(
      { error: 'Failed to read state', details: error.message, defaultState: true },
      { status: 500 }
    );
  }
}

