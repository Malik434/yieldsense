#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

const PACKED_KEYS = [
  "RPC_URL",
  "DATA_RPC_URL",
  "MAINNET_DATA_RPC_URL",
  "YIELD_CHAIN_ID",
  "KEEPER_ADDRESS",
  "POOL_ADDRESS",
  "GAUGE_ADDRESS",
  "UNISWAP_POOL_ADDRESS",
  "USER_ADDRESS",
  "CHAIN_ID",
  "TELEMETRY_URL",
  "TELEMETRY_TIMEOUT_MS",
  "FRONTEND_URL",
  "YIELD_PROCESSOR_LEASE_EPOCH",
  "GRID_CONFIG_JSON",
  "STOP_LOSS_SECRET_JSON",
  "STOP_LOSS_SIGNED_PAYLOAD",
  "FORCE_TEST_HARVEST",
  "FORCE_TEST_ALLOW_MAINNET",
  "DRY_RUN",
  "YIELD_FALLBACK_MODE",
  "POOL_FEE_BPS",
  "EST_GAS_UNITS",
  "HARVEST_MIN_ASSET_OUT",
  "STRATEGY_TVL_USD",
  "EFFICIENCY_MULTIPLIER",
  "MIN_NET_REWARD_USD",
  "MAX_GAS_USD",
  "PAYMASTER_GAS_COST_USD",
  "COOLDOWN_SEC",
  "MIN_APR_CONFIDENCE",
  "MIN_YIELD_CONFIDENCE",
  "RUN_COOLDOWN_GUARD",
  "MIN_RUN_INTERVAL_MS",
  "REMOTE_COOLDOWN_GUARD",
  "COOLDOWN_REMOTE_TIMEOUT_MS",
  "ACURAST_FAST_SUBMIT",
  "ACURAST_USE_FALLBACK_FEES",
  "WAIT_FOR_HARVEST_RECEIPT",
];

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const result = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }
  return result;
}

const fileEnv = parseEnvFile(ENV_PATH);
const config = {};

for (const key of PACKED_KEYS) {
  const value = process.env[key] ?? fileEnv[key];
  if (value != null && String(value).trim() !== "") {
    config[key] = String(value).trim();
  }
}

const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64");

console.log("YIELDSENSE_CONFIG_B64=" + encoded);
console.log("");
console.log("PowerShell:");
console.log(`$env:YIELDSENSE_CONFIG_B64='${encoded}'`);
