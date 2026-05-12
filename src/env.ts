import { GENERATED_ENV } from "./generatedEnv.js";

type EnvRecord = Record<string, string | number | boolean | null | undefined>;
type RuntimeGlobal = {
  __ENV__?: Record<string, string>;
  process?: {
    env?: Record<string, string | undefined>;
  };
};

function runtimeGlobal(): RuntimeGlobal {
  return globalThis as unknown as RuntimeGlobal;
}

function ensureProcessEnv(): Record<string, string | undefined> {
  const runtime = runtimeGlobal();
  if (!runtime.process) {
    runtime.process = { env: {} };
  }
  runtime.process.env ??= {};
  return runtime.process.env;
}

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
  const env = ensureProcessEnv();
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
  const env = ensureProcessEnv();
  const config = { ...GENERATED_ENV, ...(readPackedConfig() ?? {}) };
  if (!config) return;

  runtimeGlobal().__ENV__ = Object.fromEntries(
    Object.entries(config)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)])
  );

  for (const [key, value] of Object.entries(config)) {
    if (value == null || env[key]) continue;
    env[key] = String(value);
  }
}

applyPackedConfig();
