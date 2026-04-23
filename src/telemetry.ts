import axios from 'axios';

export interface TelemetryEvent {
  event: string;
  timestamp: number;
  [key: string]: unknown;
}

export async function emitTelemetry(event: TelemetryEvent): Promise<void> {
  // Always log to console for Acurast history
  console.log(JSON.stringify(event));

  // If a telemetry URL is provided, send it to the dashboard
  const url = process.env.TELEMETRY_URL;
  if (url) {
    try {
      await axios.post(url, event, { timeout: 3000 });
    } catch {
      // Fail silently if dashboard is unreachable
    }
  }
}
