import { NextResponse } from 'next/server';
import { applyTelemetryEvent } from '@/lib/stateStore';

export async function POST(request: Request) {
  try {
    const event = await request.json();

    if (!event || typeof event !== 'object' || !event.event) {
      return NextResponse.json({ error: 'Invalid payload — must include event name' }, { status: 400 });
    }

    await applyTelemetryEvent(event);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Telemetry Error:', error);
    return NextResponse.json({ error: 'Failed to process telemetry' }, { status: 500 });
  }
}
