const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
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

function displayRpcUrl(url) {
  try {
    const parsed = new URL(url);
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

function requireOutput(name, stdout, patterns) {
  for (const pattern of patterns) {
    if (!pattern.test(stdout)) {
      throw new Error(`${name} completed but output did not include expected marker: ${pattern}`);
    }
  }
}

function runStep(name, command, args, env, timeoutMs) {
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
    }, timeoutMs);

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
        reject(new Error(`${name} was killed by the simulation watchdog after ${timeoutMs}ms.`));
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

async function main() {
  loadDotEnvFile(path.join(ROOT, ".env"));
  if (!process.env.ACURAST_WORKER_KEY) {
    throw new Error("ACURAST_WORKER_KEY is required so the simulated mobile _STD_ has a hardware-like signer.");
  }

  const rpcUrl = process.env.RPC_URL || process.env.DATA_RPC_URL || "https://mainnet.base.org";
  const executionBudgetMs = Number(process.env.ACURAST_SIM_EXECUTION_BUDGET_MS || process.env.PROCESSOR_EXECUTION_BUDGET_MS || 50_000);
  const watchdogMs = Number(process.env.ACURAST_SIM_WATCHDOG_MS || executionBudgetMs + 12_000);
  const statePath = path.join(os.tmpdir(), `yieldsense-mobile-smoke-${randomUUID()}.json`);
  const storagePath = path.join(os.tmpdir(), `yieldsense-mobile-acurast-${randomUUID()}.json`);

  console.log("YieldSense Acurast mobile environment simulation");
  console.log(`RPC: ${displayRpcUrl(rpcUrl)}`);
  console.log(`Processor budget: ${executionBudgetMs}ms`);
  console.log(`Watchdog: ${watchdogMs}ms`);
  console.log("Broadcast: disabled by default; set ACURAST_SIM_BROADCAST=true to send a real transaction.\n");

  const env = {
    RPC_URL: rpcUrl,
    DATA_RPC_URL: process.env.DATA_RPC_URL || rpcUrl,
    MAINNET_DATA_RPC_URL: process.env.MAINNET_DATA_RPC_URL || process.env.DATA_RPC_URL || rpcUrl,
    YIELD_CHAIN_ID: process.env.YIELD_CHAIN_ID || "8453",
    CHAIN_ID: process.env.CHAIN_ID || "8453",
    STATE_PATH: statePath,
    LOCAL_ACURAST_STORAGE_PATH: storagePath,
    RUN_COOLDOWN_GUARD: "false",
    GAS_SPONSOR_MODE: process.env.ACURAST_SIM_GAS_SPONSOR_MODE || process.env.GAS_SPONSOR_MODE || "paymaster",
    MIN_NET_REWARD_USD: process.env.ACURAST_SIM_MIN_NET_REWARD_USD || "1",
    PAYMASTER_GAS_COST_USD: process.env.ACURAST_SIM_PAYMASTER_GAS_COST_USD || process.env.PAYMASTER_GAS_COST_USD || "0.015",
    ACURAST_FAST_SUBMIT: process.env.ACURAST_SIM_FAST_SUBMIT || "true",
    ACURAST_FAST_YIELD_MODE: process.env.ACURAST_SIM_FAST_YIELD_MODE || process.env.ACURAST_FAST_YIELD_MODE || "api",
    ENFORCE_PROFITABILITY: process.env.ACURAST_SIM_ENFORCE_PROFITABILITY || process.env.ENFORCE_PROFITABILITY || "true",
    ACURAST_USE_FALLBACK_FEES: process.env.ACURAST_USE_FALLBACK_FEES || "true",
    WAIT_FOR_HARVEST_RECEIPT: process.env.WAIT_FOR_HARVEST_RECEIPT || "false",
    TELEMETRY_DISABLED: process.env.TELEMETRY_DISABLED || "true",
    PROCESSOR_EXECUTION_BUDGET_MS: String(executionBudgetMs),
    PROCESSOR_SHUTDOWN_GRACE_MS: process.env.PROCESSOR_SHUTDOWN_GRACE_MS || "8000",
    RPC_REQUEST_TIMEOUT_MS: process.env.RPC_REQUEST_TIMEOUT_MS || "6000",
    RPC_CALL_TIMEOUT_MS: process.env.RPC_CALL_TIMEOUT_MS || "6000",
    RPC_LOG_TIMEOUT_MS: process.env.RPC_LOG_TIMEOUT_MS || "6000",
    YIELD_ESTIMATE_TIMEOUT_MS: process.env.YIELD_ESTIMATE_TIMEOUT_MS || "12000",
    KEEPER_READ_TIMEOUT_MS: process.env.KEEPER_READ_TIMEOUT_MS || "2500",
    FEE_DATA_TIMEOUT_MS: process.env.FEE_DATA_TIMEOUT_MS || "2500",
    PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS: process.env.PROCESSOR_CHAIN_DIAGNOSTIC_TIMEOUT_MS || "1500",
    FINAL_LOG_DRAIN_MS: process.env.FINAL_LOG_DRAIN_MS || "250",
    ACURAST_SIM_STORAGE_MAX_BYTES: process.env.ACURAST_SIM_STORAGE_MAX_BYTES || String(64 * 1024),
    ACURAST_SIM_STORAGE_LATENCY_MS: process.env.ACURAST_SIM_STORAGE_LATENCY_MS || "25",
    ACURAST_SIM_NETWORK_LATENCY_MS: process.env.ACURAST_SIM_NETWORK_LATENCY_MS || "250",
    ACURAST_SIM_NETWORK_JITTER_MS: process.env.ACURAST_SIM_NETWORK_JITTER_MS || "250",
    ACURAST_SIM_FETCH_TIMEOUT_MS: process.env.ACURAST_SIM_FETCH_TIMEOUT_MS || "12000",
    ACURAST_SIM_MAX_REQUEST_BYTES: process.env.ACURAST_SIM_MAX_REQUEST_BYTES || String(256 * 1024),
    ACURAST_SIM_MAX_RESPONSE_BYTES: process.env.ACURAST_SIM_MAX_RESPONSE_BYTES || String(1024 * 1024),
    ACURAST_SIM_BANDWIDTH_BYTES_PER_SEC: process.env.ACURAST_SIM_BANDWIDTH_BYTES_PER_SEC || String(128 * 1024),
    ACURAST_SIM_MAX_FETCH_REQUESTS: process.env.ACURAST_SIM_MAX_FETCH_REQUESTS || "80",
    ACURAST_SIM_BROADCAST: process.env.ACURAST_SIM_BROADCAST || "false",
  };

  const result = await runStep("Acurast mobile simulation", "npx", ["tsx", "scripts/mobileAcurastJob.ts"], env, watchdogMs);
  requireOutput("Acurast mobile simulation", result.stdout, [
    /\[ACURAST_SIM\] Installed constrained mobile _STD_/,
    /"hasAcurastStd":true/,
    /\[TERMINAL\] Cycle complete \(ok\)\. Exiting\./,
  ]);

  const skippedByCooldown = /"event":"run_skipped_recent"/.test(result.stdout);
  if (skippedByCooldown) {
    requireOutput("Acurast mobile simulation", result.stdout, [/"cooldownSource":"(local_storage|remote_state)"/]);
  } else {
    requireOutput("Acurast mobile simulation", result.stdout, [
      /"event":"profitability_check"/,
      /"event":"(harvest_submitted|harvest_skipped_profitability)"/,
    ]);
  }

  if (result.elapsedMs > watchdogMs) {
    throw new Error(`Simulation exceeded watchdog: ${result.elapsedMs}ms > ${watchdogMs}ms.`);
  }

  console.log(`\nAcurast mobile simulation passed in ${result.elapsedMs}ms.`);
}

main().catch((error) => {
  console.error(`\nAcurast mobile simulation failed: ${error.message}`);
  process.exitCode = 1;
});
