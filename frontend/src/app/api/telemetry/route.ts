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

  // ── Payload validation ────────────────────────────────────────────────────
  let event: Record<string, unknown>;
  try {
    event = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
    console.error(`[telemetry] REJECTED 400 — invalid payload structure: ${JSON.stringify(event).substring(0, 200)}`);
    return NextResponse.json(
      { error: 'Invalid payload — must include "event" string field' },
      { status: 400 }
    );
  }
  console.log(`[telemetry] Event type: "${event.event}" userAddress: "${event.userAddress ?? 'MISSING'}"`);

  // ── Tenant isolation: require userAddress ─────────────────────────────────
  const userAddress =
    (event.userAddress as string | undefined) ||
    (event.USER_ADDRESS as string | undefined);

  if (!userAddress || typeof userAddress !== 'string') {
    console.error(`[telemetry] REJECTED 400 — missing userAddress. Full payload keys: ${Object.keys(event).join(', ')}`);
    return NextResponse.json(
      { error: 'Missing userAddress — anonymous telemetry writes are not allowed' },
      { status: 400 }
    );
  }

  // Normalise so stateStore keys are always lowercase
  event.userAddress = userAddress.toLowerCase();

  try {
    await applyTelemetryEvent(event);
    console.log(`[telemetry] OK — persisted event "${event.event}" for user ${event.userAddress}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[telemetry] applyTelemetryEvent error:', error);
    return NextResponse.json({ error: 'Failed to process telemetry' }, { status: 500 });
  }
}
