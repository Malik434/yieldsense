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
  // Inject USER_ADDRESS from environment if not present in event
  if (process.env.USER_ADDRESS && !event.userAddress) {
    event.userAddress = process.env.USER_ADDRESS;
  }

  const payload = JSON.stringify(event);

  // STDOUT log for Acurast Console
  console.log(`[TELEMETRY_STDOUT] ${payload}`);

  const url = process.env.TELEMETRY_URL?.trim() || BUILTIN_TELEMETRY_URL;
  const secret = process.env.PROCESSOR_SHARED_SECRET?.trim();

  if (!secret) {
    console.warn("[TELEMETRY_WARN] PROCESSOR_SHARED_SECRET is missing. API will reject logs.");
  }
  
  if (!event.userAddress) {
    console.warn("[TELEMETRY_WARN] USER_ADDRESS is missing. Logs will be anonymous and likely ignored by frontend.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36 YieldSense/1.0",
    "Accept": "application/json",
  };

  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }

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
      console.error(`[TELEMETRY_ERROR] API Rejected (${response.status}): ${errorText.substring(0, 100)}`);
    }
  } catch (err: any) {
    console.error(`[TELEMETRY_ERROR] Network Failure: ${err?.message || String(err)}`);
  }
}
