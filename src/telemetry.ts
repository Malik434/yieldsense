export interface TelemetryEvent {
  event: string;
  timestamp: number;
  userAddress?: string;
  [key: string]: unknown;
}

const BUILTIN_TELEMETRY_URL = "https://yieldsense.huzaifamalik.tech/api/telemetry";

/**
 * Emits a structured telemetry event to the Next.js telemetry API.
 *
 * Authentication: every outbound POST carries an Authorization header with the
 * PROCESSOR_SHARED_SECRET env var as a Bearer token. The API rejects requests
 * that omit or provide the wrong secret, preventing public log poisoning.
 *
 * If PROCESSOR_SHARED_SECRET is not set the request is still sent but the API
 * will reject it in production (it accepts unauthenticated writes only in local
 * dev mode when the env var is also absent server-side).
 */
export async function emitTelemetry(event: TelemetryEvent): Promise<void> {
  // Inject USER_ADDRESS so the backend scopes state/logs to the correct user
  if (process.env.USER_ADDRESS && !event.userAddress) {
    event.userAddress = process.env.USER_ADDRESS;
  }

  const payload = JSON.stringify(event);

  // Always log to stdout — primary source of truth in the Acurast console
  console.log(`[TELEMETRY] ${payload}`);

  const url = process.env.TELEMETRY_URL?.trim() || BUILTIN_TELEMETRY_URL;
  const secret = process.env.PROCESSOR_SHARED_SECRET?.trim() ?? "";

  try {
    if (typeof fetch === "undefined") {
      console.error(`[TELEMETRY_ERROR] Native fetch unavailable. Logs visible in Acurast console only.`);
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (secret) {
      headers["Authorization"] = `Bearer ${secret}`;
    } else {
      // Warn once per process — missing secret means production API will reject writes
      console.warn(
        "[TELEMETRY_WARN] PROCESSOR_SHARED_SECRET not set. " +
        "Telemetry writes will be rejected by the production API."
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout to handle Netlify cold starts

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(
        `[TELEMETRY_ERROR] POST ${url} → ${response.status} ${response.statusText}`
      );
    }
  } catch (err: any) {
    console.error(`[TELEMETRY_ERROR] Failed to reach ${url}: ${err?.message ?? String(err)}`);
  }
}
