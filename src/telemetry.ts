export interface TelemetryEvent {
  event: string;
  timestamp: number;
  userAddress?: string;
  [key: string]: unknown;
}

const BUILTIN_TELEMETRY_URL = "https://yieldsense.huzaifamalik.tech/api/telemetry";

function diagnosticUrlFor(telemetryUrl: string): string | null {
  const configured = process.env.TELEMETRY_DIAGNOSTIC_URL?.trim();
  if (configured) return configured;

  try {
    const url = new URL(telemetryUrl);
    if (!url.pathname.endsWith("/api/telemetry")) return null;
    url.pathname = url.pathname.replace(/\/api\/telemetry$/, "/api/telemetry/diagnostic");
    return url.toString();
  } catch {
    return null;
  }
}

function redact(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.length <= 10) return "[set]";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function emitTelemetryDiagnostic(
  url: string,
  reason: string,
  event: TelemetryEvent,
  details: Record<string, unknown> = {}
): Promise<void> {
  const diagnosticUrl = diagnosticUrlFor(url);
  if (!diagnosticUrl || typeof fetch === "undefined") return;

  const envUser = process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS;
  const envChainId = process.env.CHAIN_ID || (globalThis as any).__ENV__?.CHAIN_ID;

  const payload = {
    event: "telemetry_config_error",
    timestamp: Math.floor(Date.now() / 1000),
    userAddress: event.userAddress || envUser,
    chainId: event.chainId || (envChainId ? Number(envChainId) : undefined),
    reason,
    originalEvent: event.event,
    hasTelemetryUrl: Boolean(url),
    hasProcessorSharedSecret: Boolean(process.env.PROCESSOR_SHARED_SECRET || (globalThis as any).__ENV__?.PROCESSOR_SHARED_SECRET),
    hasAcurastStd: Boolean((globalThis as any)._STD_),
    dryRun: process.env.DRY_RUN,
    forceTestHarvest: process.env.FORCE_TEST_HARVEST,
    rpcUrl: redact(process.env.RPC_URL),
    dataRpcUrl: redact(process.env.DATA_RPC_URL),
    ...details,
  };

  try {
    await fetch(diagnosticUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) YieldSense-Guardian/1.0 diagnostic",
        "Accept": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Last-resort diagnostics must never change processor control flow.
  }
}

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

  if (process.env.TELEMETRY_DISABLED === "true") {
    return;
  }

  if (!secret) {
    console.error("[TELEMETRY_ERROR] PROCESSOR_SHARED_SECRET is missing; event was only written to stdout.");
    await emitTelemetryDiagnostic(url, "missing_processor_shared_secret", event);
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
      await emitTelemetryDiagnostic(url, "telemetry_api_rejected", event, {
        status: response.status,
        responseText: errorText.substring(0, 150),
      });
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
    await emitTelemetryDiagnostic(url, "telemetry_network_failure", event, {
      message: err?.message || String(err),
    });
  }
}
