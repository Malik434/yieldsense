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
  const localAcurastStoragePath = path.join(os.tmpdir(), `yieldsense-local-acurast-${randomUUID()}.json`);
  const workerEnv = {
    RPC_URL: rpcUrl,
    DATA_RPC_URL: process.env.DATA_RPC_URL || rpcUrl,
    MAINNET_DATA_RPC_URL: process.env.MAINNET_DATA_RPC_URL || rpcUrl,
    YIELD_CHAIN_ID: process.env.YIELD_CHAIN_ID || "8453",
    CHAIN_ID: process.env.CHAIN_ID || "8453",
    DRY_RUN: "false",
    LOCAL_ACURAST_STORAGE_PATH: localAcurastStoragePath,
    RUN_COOLDOWN_GUARD: "false",
    STATE_PATH: statePath,
    YIELD_FALLBACK_MODE: process.env.YIELD_FALLBACK_MODE || "api",
    RPC_REQUEST_TIMEOUT_MS: process.env.RPC_REQUEST_TIMEOUT_MS || "15000",
    RPC_CALL_TIMEOUT_MS: process.env.RPC_CALL_TIMEOUT_MS || "15000",
    RPC_LOG_TIMEOUT_MS: process.env.RPC_LOG_TIMEOUT_MS || "15000",
    RPC_CHUNK_DELAY_MS: process.env.RPC_CHUNK_DELAY_MS || "250",
    YIELD_ESTIMATE_TIMEOUT_MS: process.env.SMOKE_YIELD_ESTIMATE_TIMEOUT_MS || "12000",
    KEEPER_READ_TIMEOUT_MS: process.env.KEEPER_READ_TIMEOUT_MS || "8000",
    FEE_DATA_TIMEOUT_MS: process.env.FEE_DATA_TIMEOUT_MS || "8000",
    EST_GAS_UNITS: process.env.SMOKE_EST_GAS_UNITS || "1200000",
    ACURAST_FAST_SUBMIT: process.env.SMOKE_ACURAST_FAST_SUBMIT || "true",
    ACURAST_FAST_YIELD_MODE: process.env.SMOKE_ACURAST_FAST_YIELD_MODE || "api",
    ACURAST_USE_FALLBACK_FEES: process.env.SMOKE_ACURAST_USE_FALLBACK_FEES || "true",
    WAIT_FOR_HARVEST_RECEIPT: process.env.SMOKE_WAIT_FOR_HARVEST_RECEIPT || "false",
    ENFORCE_PROFITABILITY: process.env.SMOKE_ENFORCE_PROFITABILITY || "false",
  };

  const worker = await runStep("Harvest worker local Acurast execution", "npx", ["tsx", "scripts/localAcurastJob.ts"], workerEnv);
  requireOutput("Harvest worker local Acurast execution", worker.stdout, [
    /\[LOCAL_ACURAST_STD\] Installed local _STD_/,
    /"hasAcurastStd":true/,
    /"event":"harvest_submit_attempt"/,
    /"payloadHash":"0x[0-9a-fA-F]{64}"/,
  ]);
  requireAnyOutput("Harvest worker local Acurast execution", worker.stdout, [
    /"event":"harvest_submitted"/,
    /"event":"harvest_submission_failed"/,
    /"event":"harvest_receipt_wait_failed"/,
    /"event":"harvest_confirmed"/,
  ]);
  console.log(`\nHarvest worker local Acurast execution finished in ${worker.elapsedMs}ms`);
}

async function main() {
  console.log("YieldSense mainnet processor smoke test");
  if (!process.env.ACURAST_WORKER_KEY) {
    throw new Error("ACURAST_WORKER_KEY is required. This smoke test installs a local _STD_ shim and sends a real transaction.");
  }
  console.warn("WARNING: this smoke test sends a real Base mainnet transaction via the local Acurast _STD_ shim.");
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
