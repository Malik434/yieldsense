export const PROCESSOR_NOT_ATTESTED_SELECTOR = "0x326c7612";

export interface RecentRunInput {
  runCooldownGuard: boolean;
  lastRunAt: number | null | undefined;
  suggestedNextCheckMs: number | null | undefined;
  nowSec: number;
  minRunIntervalMs: number;
}

export interface RecentRunDecision {
  skip: boolean;
  waitMs: number;
  elapsedMs: number;
  intervalMs: number;
}

export function calculateSupervisorDelayMs(input: {
  minRunIntervalMs: number;
  suggestedNextCheckMs: number | null | undefined;
}): number {
  const configuredInterval = Number.isFinite(input.minRunIntervalMs)
    ? input.minRunIntervalMs
    : 60_000;
  const suggestedInterval = Number.isFinite(input.suggestedNextCheckMs ?? NaN)
    ? Number(input.suggestedNextCheckMs)
    : 0;

  return Math.max(15_000, configuredInterval, suggestedInterval);
}

export function calculateRecentRunSkip(input: RecentRunInput): RecentRunDecision {
  if (!input.runCooldownGuard || !input.lastRunAt) {
    return { skip: false, waitMs: 0, elapsedMs: Number.MAX_SAFE_INTEGER, intervalMs: 0 };
  }

  const intervalMs = calculateSupervisorDelayMs({
    minRunIntervalMs: input.minRunIntervalMs,
    suggestedNextCheckMs: input.suggestedNextCheckMs,
  });
  const elapsedMs = Math.max(0, (input.nowSec - input.lastRunAt) * 1000);
  const waitMs = Math.max(0, intervalMs - elapsedMs);

  return {
    skip: waitMs > 0,
    waitMs,
    elapsedMs,
    intervalMs,
  };
}

export function serialiseError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack?.split("\n").slice(0, 8).join("\n"),
    };
  }

  return { message: String(error) };
}

export function isProcessorNotAttestedError(error: unknown): boolean {
  const err = error as {
    data?: string;
    error?: { data?: string };
    info?: { error?: { data?: string } };
    shortMessage?: string;
    message?: string;
  };
  const candidates = [
    err?.data,
    err?.error?.data,
    err?.info?.error?.data,
    err?.shortMessage,
    err?.message,
  ].filter(Boolean).map(String);

  return candidates.some((value) =>
    value.includes(PROCESSOR_NOT_ATTESTED_SELECTOR) ||
    value.includes("ProcessorNotAttested") ||
    value.includes("NotAttestedProcessor")
  );
}
