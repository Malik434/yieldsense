import { NextResponse } from 'next/server';
import { applyTelemetryEvent } from '@/lib/stateStore';

/**
 * POST /api/telemetry
 *
 * Receives structured telemetry events from Acurast processor runtimes and
 * persists them to the per-user Netlify Blobs state store.
 *
 * Authentication:
 *   Every request must carry:  Authorization: Bearer <PROCESSOR_SHARED_SECRET>
 *
 *   If PROCESSOR_SHARED_SECRET is not set in server env, the endpoint operates
 *   in LOCAL DEV mode and accepts all requests (with a console warning).
 *   In production this env var MUST be set — unauthenticated writes allow any
 *   public caller to forge state for any user.
 *
 * Tenant isolation:
 *   The event payload MUST contain a `userAddress` field.
 *   Writes without a userAddress are rejected — there is no global fallback key.
 */
export async function POST(request: Request) {
  const incomingIp = request.headers.get('x-forwarded-for') ?? 'unknown';
  const incomingUA = request.headers.get('user-agent') ?? 'unknown';
  console.log(`[telemetry] Incoming POST from IP=${incomingIp} UA=${incomingUA.substring(0, 80)}`);

  // ── Authentication ────────────────────────────────────────────────────────
  // PROCESSOR_SHARED_SECRET must be set in the environment.
  // There is no hardcoded fallback — a missing secret means the server is
  // misconfigured, not that it should accept all requests. The previous
  // fallback value was committed to the repository and is therefore public.
  const secret = process.env.PROCESSOR_SHARED_SECRET?.trim();

  if (!secret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        '[telemetry] PROCESSOR_SHARED_SECRET is not set. ' +
        'Accepting request in local dev mode only. ' +
        'Set this env var before deploying to production.'
      );
    } else {
      console.error('[telemetry] REJECTED 503 — PROCESSOR_SHARED_SECRET is not set in production environment.');
      return NextResponse.json(
        { error: 'Server not configured — PROCESSOR_SHARED_SECRET must be set' },
        { status: 503 }
      );
    }
  } else {
    const authHeader = request.headers.get('Authorization') ?? '';
    const providedToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';

    if (providedToken !== secret) {
      console.error(`[telemetry] REJECTED 401 — token mismatch. Provided: "${providedToken.substring(0, 12)}..." Expected prefix: "${secret.substring(0, 12)}..."`);
      return NextResponse.json(
        { error: 'Unauthorized — invalid or missing Bearer token' },
        { status: 401 }
      );
    }
    console.log('[telemetry] Auth OK');
  }

  // ── Payload processing ────────────────────────────────────────────────────
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const events = Array.isArray(body) ? body : [body];
  let processedCount = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
      console.warn(`[telemetry] Skipping invalid event structure: ${JSON.stringify(event).substring(0, 100)}`);
      continue;
    }

    const userAddress = (event.userAddress as string | undefined) || (event.USER_ADDRESS as string | undefined);
    if (!userAddress || typeof userAddress !== 'string') {
      console.warn(`[telemetry] Skipping event missing userAddress: ${event.event}`);
      continue;
    }

    // Normalise so stateStore keys are always lowercase
    event.userAddress = userAddress.toLowerCase();

    try {
      await applyTelemetryEvent(event);
      processedCount++;
    } catch (error) {
      console.error(`[telemetry] Error processing event "${event.event}":`, error);
    }
  }

  console.log(`[telemetry] OK — processed ${processedCount} events from batch of ${events.length}`);
  return NextResponse.json({ success: true, count: processedCount });
}
