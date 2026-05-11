import { GENERATED_ENV } from "./generatedEnv.js";

type EnvRecord = Record<string, string | number | boolean | null | undefined>;

function decodeBase64(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "base64").toString("utf8");
  }

  const atobFn = (globalThis as unknown as { atob?: (input: string) => string }).atob;
  if (!atobFn) {
    throw new Error("Base64 config decoding is unavailable in this runtime.");
  }
  return atobFn(value);
}

function readPackedConfig(): EnvRecord | null {
  const env = process.env;
  const rawJson = env.YIELDSENSE_CONFIG_JSON?.trim();
  const rawB64 = env.YIELDSENSE_CONFIG_B64?.trim();

  if (!rawJson && !rawB64) return null;

  const json = rawJson || decodeBase64(rawB64!);
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YIELDSENSE_CONFIG must decode to a JSON object.");
  }
  return parsed as EnvRecord;
}

function applyPackedConfig(): void {
  const config = { ...GENERATED_ENV, ...(readPackedConfig() ?? {}) };
  if (!config) return;

  for (const [key, value] of Object.entries(config)) {
    if (value == null || process.env[key]) continue;
    process.env[key] = String(value);
  }
}

applyPackedConfig();
