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
 * Note: Environment variables (USER_ADDRESS, PROCESSOR_SHARED_SECRET) must be 
 * injected by the Acurast Hub during deployment.
 */
export async function emitTelemetry(event: TelemetryEvent): Promise<void> {
  // ── Environment Baking & Bulletproof Fallbacks ────────────────────────────
  const envUser = process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS;
  if (!event.userAddress) {
    event.userAddress = envUser;
  }

  const envChainId = process.env.CHAIN_ID || (globalThis as any).__ENV__?.CHAIN_ID;
  if (envChainId && !event.chainId) {
    event.chainId = Number(envChainId);
  }

  const url = process.env.TELEMETRY_URL?.trim() || BUILTIN_TELEMETRY_URL;
  const secret = process.env.PROCESSOR_SHARED_SECRET?.trim() || (globalThis as any).__ENV__?.PROCESSOR_SHARED_SECRET;

  const payload = JSON.stringify(event);

  // STDOUT log for Acurast Console diagnostics
  console.log(`[TELEMETRY_STDOUT] ${payload}`);

  if (!secret) {
    console.error("[TELEMETRY_ERROR] PROCESSOR_SHARED_SECRET is missing; event was only written to stdout.");
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) YieldSense-Guardian/1.0",
    "Accept": "application/json",
    "Authorization": `Bearer ${secret}`
  };

  try {
    if (typeof fetch === "undefined") {
      console.error(`[TELEMETRY_ERROR] fetch is undefined.`);
      return;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "no-body");
      console.error(`[TELEMETRY_ERROR] API Rejected (${response.status}): ${errorText.substring(0, 150)}`);
      // Special hint for common Acurast deployment issues
      if (response.status === 400) {
        console.warn(`[TELEMETRY_HINT] 400 usually means USER_ADDRESS is missing or invalid. Check your deployment environment.`);
      }
      if (response.status === 401) {
        console.warn(`[TELEMETRY_HINT] 401 means PROCESSOR_SHARED_SECRET mismatch.`);
      }
    } else {
      console.log(`[TELEMETRY_OK] Event "${event.event}" transmitted successfully.`);
    }
  } catch (err: any) {
    console.error(`[TELEMETRY_ERROR] Network Failure: ${err?.message || String(err)}`);
  }
}
