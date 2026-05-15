export interface TelemetryEvent {
  event: string;
  timestamp: number;
  userAddress?: string;
  [key: string]: unknown;
}

export interface TelemetryFlushResult {
  status: "skipped_empty" | "sent" | "dropped_missing_secret" | "http_error" | "network_error";
  attemptedCount: number;
  sentCount: number;
  requeuedCount: number;
  httpStatus?: number;
  errorMessage?: string;
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
 * Events are also written to stdout immediately for Acurast console diagnostics.
 */
export async function emitTelemetry(event: TelemetryEvent, immediate: boolean = false): Promise<void> {
  const envUser = process.env.USER_ADDRESS || (globalThis as any).__ENV__?.USER_ADDRESS;
  if (!event.userAddress) {
    event.userAddress = envUser;
  }

  const envChainId = process.env.CHAIN_ID || (globalThis as any).__ENV__?.CHAIN_ID;
  if (envChainId && !event.chainId) {
    event.chainId = Number(envChainId);
  }

  console.log(`[TELEMETRY_STDOUT] ${JSON.stringify(event)}`);

  if (process.env.TELEMETRY_DISABLED !== "true") {
    telemetryBuffer.push(event);
    if (immediate) {
      await flushTelemetry().catch(() => undefined);
    }
  }
}

/**
 * Transmits all buffered telemetry events to the Next.js API in a single batch.
 * The result is explicit so the processor can OP_LOG real flush status before exit.
 */
export async function flushTelemetry(): Promise<TelemetryFlushResult> {
  if (telemetryBuffer.length === 0) {
    return {
      status: "skipped_empty",
      attemptedCount: 0,
      sentCount: 0,
      requeuedCount: 0,
    };
  }

  const eventsToFlush = [...telemetryBuffer];
  telemetryBuffer = [];

  const url = process.env.TELEMETRY_URL?.trim() || BUILTIN_TELEMETRY_URL;
  const secret = process.env.PROCESSOR_SHARED_SECRET?.trim() || (globalThis as any).__ENV__?.PROCESSOR_SHARED_SECRET;

  if (!secret) {
    console.error(`[TELEMETRY_ERROR] PROCESSOR_SHARED_SECRET missing - ${eventsToFlush.length} events dropped.`);
    return {
      status: "dropped_missing_secret",
      attemptedCount: eventsToFlush.length,
      sentCount: 0,
      requeuedCount: 0,
      errorMessage: "PROCESSOR_SHARED_SECRET missing",
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) YieldSense-Guardian/1.0",
    Accept: "application/json",
    Authorization: `Bearer ${secret}`,
  };

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(eventsToFlush),
    }, positiveIntEnv("TELEMETRY_TIMEOUT_MS", 3_000));

    if (!response.ok) {
      const errorText = await response.text().catch(() => "no-body");
      console.error(`[TELEMETRY_ERROR] Batch Failed (${response.status}): ${errorText.substring(0, 150)}`);
      const shouldRequeue = response.status >= 500;
      if (shouldRequeue) {
        telemetryBuffer = [...eventsToFlush, ...telemetryBuffer];
      }
      return {
        status: "http_error",
        attemptedCount: eventsToFlush.length,
        sentCount: 0,
        requeuedCount: shouldRequeue ? eventsToFlush.length : 0,
        httpStatus: response.status,
        errorMessage: errorText.substring(0, 300),
      };
    }

    console.log(`[TELEMETRY_OK] Batch of ${eventsToFlush.length} events transmitted successfully.`);
    return {
      status: "sent",
      attemptedCount: eventsToFlush.length,
      sentCount: eventsToFlush.length,
      requeuedCount: 0,
      httpStatus: response.status,
    };
  } catch (err: any) {
    console.error(`[TELEMETRY_ERROR] Network Failure during flush: ${err?.message || String(err)}`);
    telemetryBuffer = [...eventsToFlush, ...telemetryBuffer];
    return {
      status: "network_error",
      attemptedCount: eventsToFlush.length,
      sentCount: 0,
      requeuedCount: eventsToFlush.length,
      errorMessage: err?.message || String(err),
    };
  }
}
