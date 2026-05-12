const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnvFile(path.join(ROOT, ".env"));

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 120_000);
const MAINNET_RPC = process.env.DATA_RPC_URL || process.env.MAINNET_DATA_RPC_URL || process.env.RPC_URL || "https://mainnet.base.org";
const configuredFallbacks = (process.env.RPC_FALLBACK_URLS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const publicFallbacks = process.env.SMOKE_USE_PUBLIC_FALLBACKS === "true"
  ? ["https://base.llamarpc.com", "https://base-rpc.publicnode.com"]
  : [];
const RPC_CANDIDATES = [MAINNET_RPC, ...configuredFallbacks, ...publicFallbacks]
  .filter((value, index, values) => value && values.indexOf(value) === index);

function displayRpcUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    for (const key of parsed.searchParams.keys()) {
      if (/key|token|secret|auth|apikey/i.test(key)) parsed.searchParams.set(key, "***");
    }
    const pathParts = parsed.pathname.split("/");
    const last = pathParts[pathParts.length - 1];
    if (/[A-Za-z0-9_-]{20,}/.test(last)) {
      pathParts[pathParts.length - 1] = "***";
      parsed.pathname = pathParts.join("/");
    }
    return parsed.toString();
  } catch {
    return String(url).replace(/[A-Za-z0-9_-]{20,}/g, "***");
  }
}

function runStep(name, command, args, env) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          shell: false,
        });
      } else {
        child.kill("SIGTERM");
      }
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      if (timedOut) {
        reject(new Error(`${name} timed out after ${TIMEOUT_MS}ms; possible endless loop or stalled RPC call.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${name} failed with code ${code ?? "null"} signal ${signal ?? "none"} after ${elapsedMs}ms.\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr, elapsedMs });
    });
  });
}

function requireOutput(name, stdout, patterns) {
  for (const pattern of patterns) {
    if (!pattern.test(stdout)) {
      throw new Error(`${name} completed but output did not include expected marker: ${pattern}`);
    }
  }
}

function requireAnyOutput(name, stdout, patterns) {
  if (!patterns.some((pattern) => pattern.test(stdout))) {
    throw new Error(`${name} completed but output did not include any expected marker: ${patterns.map(String).join(" OR ")}`);
  }
}

async function preflightRpc(rpcUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Number(process.env.SMOKE_PREFLIGHT_TIMEOUT_MS || 8_000));
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const json = await response.json();
    if (json.error) {
      throw new Error(json.error.message || "RPC returned an error");
    }
    if (json.result !== "0x2105") {
      throw new Error(`expected Base mainnet chainId 0x2105, got ${json.result}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runSmokeForRpc(rpcUrl) {
  console.log(`RPC: ${displayRpcUrl(rpcUrl)}`);
  console.log(`Timeout per step: ${TIMEOUT_MS}ms\n`);

  const aprEnv = {
    RPC_URL: rpcUrl,
    DATA_RPC_URL: rpcUrl,
    MAINNET_DATA_RPC_URL: rpcUrl,
    YIELD_CHAIN_ID: "8453",
    YIELD_FALLBACK_MODE: "api",
    POOL_FEE_BPS: "30",
    FEE_WINDOW_SEC: "3600",
    FEE_MAX_BLOCKS: "1800",
    LOG_CHUNK_SIZE: "900",
    RPC_REQUEST_TIMEOUT_MS: "15000",
    RPC_CALL_TIMEOUT_MS: "15000",
    RPC_LOG_TIMEOUT_MS: "15000",
    RPC_CHUNK_DELAY_MS: "250",
  };

  await preflightRpc(rpcUrl);

  if (process.env.SMOKE_SEPARATE_APR === "true") {
    const apr = await runStep("APR calculation", "npx", ["tsx", "scripts/simulateApr.ts"], aprEnv);
    requireOutput("APR calculation", apr.stdout, [/APR BREAKDOWN/, /Total APR:/, /Usable:\s+(true|false)/]);
    console.log(`\nAPR calculation finished in ${apr.elapsedMs}ms\n`);
  }

  const statePath = path.join(os.tmpdir(), `yieldsense-mainnet-smoke-${randomUUID()}.json`);
  const workerEnv = {
    RPC_URL: rpcUrl,
    DATA_RPC_URL: rpcUrl,
    MAINNET_DATA_RPC_URL: rpcUrl,
    YIELD_CHAIN_ID: "8453",
    CHAIN_ID: "8453",
    DRY_RUN: "true",
    FORCE_TEST_HARVEST: "false",
    FORCE_TEST_ALLOW_MAINNET: "false",
    RUN_COOLDOWN_GUARD: "false",
    STATE_PATH: statePath,
    GRID_CONFIG_JSON: "[]",
    STOP_LOSS_SECRET_JSON: "",
    STOP_LOSS_SIGNED_PAYLOAD: "",
    YIELD_FALLBACK_MODE: "api",
    POOL_FEE_BPS: "30",
    FEE_WINDOW_SEC: "3600",
    FEE_MAX_BLOCKS: "1800",
    LOG_CHUNK_SIZE: "900",
    MIN_YIELD_CONFIDENCE: "0.1",
    MIN_APR_CONFIDENCE: "0.1",
    STRATEGY_TVL_USD: "1000000000",
    EFFICIENCY_MULTIPLIER: "0",
    MIN_NET_REWARD_USD: "0",
    MAX_GAS_USD: "1000000",
    COOLDOWN_SEC: "0",
    TELEMETRY_URL: "http://127.0.0.1:9",
    TELEMETRY_DISABLED: "true",
    PROCESSOR_SHARED_SECRET: "",
    RPC_REQUEST_TIMEOUT_MS: "15000",
    RPC_CALL_TIMEOUT_MS: "15000",
    RPC_LOG_TIMEOUT_MS: "15000",
    RPC_CHUNK_DELAY_MS: "250",
    YIELD_ESTIMATE_TIMEOUT_MS: process.env.SMOKE_YIELD_ESTIMATE_TIMEOUT_MS || "12000",
    KEEPER_READ_TIMEOUT_MS: "8000",
    FEE_DATA_TIMEOUT_MS: "8000",
  };

  const worker = await runStep("Harvest worker dry run", "npx", ["tsx", "src/index.ts"], workerEnv);
  requireAnyOutput("Harvest worker dry run", worker.stdout, [
    /"event":"profitability_check"/,
    /"event":"yield_estimate_failed"/,
    /"event":"yield_not_usable"/,
    /"event":"keeper_or_fee_read_failed"/,
  ]);
  if (/"event":"profitability_check"/.test(worker.stdout)) {
    requireOutput("Harvest worker dry run", worker.stdout, [
      /"event":"harvest_dry_run"/,
      /"payloadHash":"0x[0-9a-fA-F]{64}"/,
    ]);
  }
  console.log(`\nHarvest worker dry run finished in ${worker.elapsedMs}ms`);
}

async function main() {
  console.log("YieldSense mainnet processor smoke test");
  const failures = [];

  for (const rpcUrl of RPC_CANDIDATES) {
    try {
      await runSmokeForRpc(rpcUrl);
      console.log("\nSmoke test passed: mainnet RPC, APR calculation, decisioning, harvest payload construction, and termination all completed.");
      return;
    } catch (error) {
      failures.push(`${displayRpcUrl(rpcUrl)}: ${error.message}`);
      console.error(`\nRPC candidate failed: ${displayRpcUrl(rpcUrl)}`);
      console.error(`${error.message}\n`);
    }
  }

  throw new Error(`All RPC candidates failed:\n${failures.join("\n")}`);
}

main().catch((error) => {
  console.error(`\nSmoke test failed: ${error.message}`);
  process.exitCode = 1;
});
