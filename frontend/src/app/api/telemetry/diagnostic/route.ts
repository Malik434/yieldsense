import { NextResponse } from 'next/server';
import { applyTelemetryEvent } from '@/lib/stateStore';

const ALLOWED_EVENTS = new Set(['telemetry_config_error']);

function enabled(): boolean {
  return process.env.ENABLE_UNAUTH_TELEMETRY_DIAGNOSTICS === 'true';
}

function cleanString(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, maxLength);
}

/**
 * Last-resort telemetry diagnostics.
 *
 * This endpoint intentionally does not use PROCESSOR_SHARED_SECRET because its
 * only purpose is to make missing/mismatched telemetry credentials visible.
 * It is disabled unless ENABLE_UNAUTH_TELEMETRY_DIAGNOSTICS=true is set on the
 * frontend deployment, and it only accepts a tiny allowlist of sanitized config
 * failure events.
 */
export async function POST(request: Request) {
  if (!enabled()) {
    return NextResponse.json({ error: 'diagnostic telemetry disabled' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const eventName = cleanString(body.event, 80);
  const userAddress = cleanString(body.userAddress, 80);

  if (!eventName || !ALLOWED_EVENTS.has(eventName)) {
    return NextResponse.json({ error: 'event not allowed' }, { status: 400 });
  }

  if (!userAddress || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
    return NextResponse.json({ error: 'invalid userAddress' }, { status: 400 });
  }

  const event = {
    event: eventName,
    timestamp: Number(body.timestamp) || Math.floor(Date.now() / 1000),
    userAddress,
    chainId: Number(body.chainId) || undefined,
    reason: cleanString(body.reason, 120),
    originalEvent: cleanString(body.originalEvent, 120),
    status: typeof body.status === 'number' ? body.status : undefined,
    message: cleanString(body.message, 240),
    responseText: cleanString(body.responseText, 180),
    hasTelemetryUrl: Boolean(body.hasTelemetryUrl),
    hasProcessorSharedSecret: Boolean(body.hasProcessorSharedSecret),
    hasAcurastStd: Boolean(body.hasAcurastStd),
    dryRun: cleanString(body.dryRun, 16),
    forceTestHarvest: cleanString(body.forceTestHarvest, 16),
    diagnostic: true,
  };

  await applyTelemetryEvent(event);
  return NextResponse.json({ success: true });
}
