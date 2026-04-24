import axios from 'axios';

export interface TelemetryEvent {
  event: string;
  timestamp: number;
  [key: string]: unknown;
}

// Built-in fallback so telemetry reaches the dashboard even when the
// Acurast CLI failed to store env vars on-chain for this deployment.
const BUILTIN_TELEMETRY_URL = "https://yieldsense.huzaifamalik.tech/api/telemetry";

export async function emitTelemetry(event: TelemetryEvent): Promise<void> {
  // Always log to console for Acurast history
  console.log(JSON.stringify(event));

  // Prefer the env var; fall back to the built-in URL.
  const url = process.env.TELEMETRY_URL?.trim() || BUILTIN_TELEMETRY_URL;
  try {
    await axios.post(url, event, { timeout: 3000 });
  } catch {
    // Fail silently if dashboard is unreachable
  }
}
