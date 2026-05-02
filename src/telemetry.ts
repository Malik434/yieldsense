import axiosLib from "axios";
// CommonJS/ESM interop: axios default export differs between module systems
const axios = (axiosLib as any).default ?? axiosLib;

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
 * Uses axios for maximum compatibility inside the Acurast TEE Node.js runtime.
 * Verbose debug logging included so failures are always visible in Acurast console.
 */
export async function emitTelemetry(event: TelemetryEvent): Promise<void> {
  // Inject USER_ADDRESS so the backend scopes state/logs to the correct user
  if (process.env.USER_ADDRESS && !event.userAddress) {
    event.userAddress = process.env.USER_ADDRESS;
  }

  // Always log to stdout — primary source of truth in the Acurast console
  console.log(`[TELEMETRY] ${JSON.stringify(event)}`);

  const url = process.env.TELEMETRY_URL?.trim() || BUILTIN_TELEMETRY_URL;
  const secret = process.env.PROCESSOR_SHARED_SECRET?.trim() ?? "";

  // ── Debug: log env var presence so we can detect injection failures in the Acurast console
  console.log(`[TELEMETRY_DEBUG] url=${url} secret_present=${!!secret} userAddress=${event.userAddress ?? "MISSING"}`);

  if (!secret) {
    console.warn(
      "[TELEMETRY_WARN] PROCESSOR_SHARED_SECRET not set — API will reject this request with 401. " +
      "Ensure this env var is set in the Acurast Console environment variables."
    );
  }

  if (!event.userAddress) {
    console.warn(
      "[TELEMETRY_WARN] userAddress is missing from telemetry payload — API will reject with 400. " +
      "Ensure USER_ADDRESS is set in the Acurast Console environment variables."
    );
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
    const response = await axios.post(url, event, {
      headers,
      timeout: 15000,
      validateStatus: null, // Don't throw on non-2xx — handle manually below
    });

    // ── Debug: always log the API response so we can see 401/400 in the Acurast console
    console.log(`[TELEMETRY_DEBUG] POST ${url} → HTTP ${response.status}`);

    if (response.status < 200 || response.status >= 300) {
      console.error(
        `[TELEMETRY_ERROR] POST ${url} → ${response.status}. ` +
        `Response: ${JSON.stringify(response.data ?? "").substring(0, 200)}`
      );
    }
  } catch (err: any) {
    console.error(`[TELEMETRY_ERROR] Failed to reach ${url}: ${err?.message ?? String(err)}`);
  }
}
