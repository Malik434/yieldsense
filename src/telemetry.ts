export interface TelemetryEvent {
  event: string;
  timestamp: number;
  [key: string]: unknown;
}

export function emitTelemetry(event: TelemetryEvent): void {
  console.log(JSON.stringify(event));
}
