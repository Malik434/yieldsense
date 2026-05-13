export interface TelemetryEvent {
  event: string;
  timestamp: number;
  userAddress?: string;
  [key: string]: unknown;
}

const BUILTIN_TELEMETRY_URL = "https://yieldsense.huzaifamalik.tech/api/telemetry";

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

let telemetryBuffer: TelemetryEvent[] = [];

/**
 * Buffers a telemetry event for later batch transmission.
 * Events are only written to stdout immediately; network calls are deferred to flushTelemetry().
 */
export async function emitTelemetry(event: TelemetryEvent): Promise<void> {
  const envUser = process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS;
  if (!event.userAddress) {
    event.userAddress = envUser;
  }

  const envChainId = process.env.CHAIN_ID || (globalThis as any).__ENV__?.CHAIN_ID;
  if (envChainId && !event.chainId) {
    event.chainId = Number(envChainId);
  }

  // STDOUT log for Acurast Console diagnostics (immediate)
  console.log(`[TELEMETRY_STDOUT] ${JSON.stringify(event)}`);

  if (process.env.TELEMETRY_DISABLED !== "true") {
    telemetryBuffer.push(event);
  }
}

/**
 * Transmits all buffered telemetry events to the Next.js API in a single batch.
 */
export async function flushTelemetry(): Promise<void> {
  if (telemetryBuffer.length === 0) return;

  const eventsToFlush = [...telemetryBuffer];
  telemetryBuffer = []; // Clear immediately

  const url = process.env.TELEMETRY_URL?.trim() || BUILTIN_TELEMETRY_URL;
  const secret = process.env.PROCESSOR_SHARED_SECRET?.trim() || (globalThis as any).__ENV__?.PROCESSOR_SHARED_SECRET;

  if (!secret) {
    console.error(`[TELEMETRY_ERROR] PROCESSOR_SHARED_SECRET missing — ${eventsToFlush.length} events dropped.`);
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) YieldSense-Guardian/1.0",
    "Accept": "application/json",
    "Authorization": `Bearer ${secret}`
  };

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(eventsToFlush),
    }, positiveIntEnv("TELEMETRY_TIMEOUT_MS", 10_000));

    if (!response.ok) {
      const errorText = await response.text().catch(() => "no-body");
      console.error(`[TELEMETRY_ERROR] Batch Failed (${response.status}): ${errorText.substring(0, 150)}`);
      // Re-queue on 5xx
      if (response.status >= 500) {
        telemetryBuffer = [...eventsToFlush, ...telemetryBuffer];
      }
    } else {
      console.log(`[TELEMETRY_OK] Batch of ${eventsToFlush.length} events transmitted successfully.`);
    }
  } catch (err: any) {
    console.error(`[TELEMETRY_ERROR] Network Failure during flush: ${err?.message || String(err)}`);
    telemetryBuffer = [...eventsToFlush, ...telemetryBuffer];
  }
}
