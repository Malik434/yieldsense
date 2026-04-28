export interface TelemetryEvent {
  event: string;
  timestamp: number;
  [key: string]: unknown;
}

// Built-in fallback so telemetry reaches the dashboard even when the
// Acurast CLI failed to store env vars on-chain for this deployment.
const BUILTIN_TELEMETRY_URL = "https://yieldsense.huzaifamalik.tech/api/telemetry";

export async function emitTelemetry(event: TelemetryEvent): Promise<void> {
  const payload = JSON.stringify(event);
  
  // 1. Always log to console. This is the source of truth for Acurast logs.
  console.log(`[TELEMETRY] ${payload}`);

  // 2. Prefer the env var; fall back to the built-in URL.
  const url = process.env.TELEMETRY_URL?.trim() || BUILTIN_TELEMETRY_URL;

  try {
    // 3. Use fetch if available (standard in TEE)
    if (typeof fetch !== 'undefined') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        console.error(`[TELEMETRY_ERROR] POST to ${url} failed with status ${response.status}: ${response.statusText}`);
      }
    } else {
      console.error(`[TELEMETRY_ERROR] Native fetch unavailable for ${url}. Logs only visible in Acurast console.`);
    }
  } catch (err: any) {
    // 4. Log the error specifically so we can debug on-chain failures
    console.error(`[TELEMETRY_ERROR] Failed to reach ${url}: ${err?.message || String(err)}`);
  }
}
