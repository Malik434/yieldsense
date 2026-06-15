"use strict";

const path = require("node:path");

const bundlePath = path.join(__dirname, "..", "dist", "processor.bundle.cjs");
const processor = require(bundlePath);

const pollIntervalMs = Number(process.env.PROCESSOR_LOCAL_POLL_INTERVAL_MS || process.env.POLL_INTERVAL_MS || 60_000);
const runOnce = process.env.PROCESSOR_RUN_ONCE === "true";

async function runCycle() {
  if (typeof processor.monitorAndExecuteGrid !== "function") {
    throw new Error("dist/processor.bundle.cjs does not export monitorAndExecuteGrid. Run `npm run build` first.");
  }

  await processor.monitorAndExecuteGrid();
}

async function main() {
  console.log(JSON.stringify({
    event: "local_processor_start",
    runOnce,
    pollIntervalMs,
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
    liveGridExecutor: process.env.ENABLE_LIVE_GRID_EXECUTOR === "true",
  }));

  do {
    try {
      await runCycle();
    } catch (error) {
      console.error(JSON.stringify({
        event: "local_processor_error",
        message: error instanceof Error ? error.message : String(error),
      }));
      if (runOnce) process.exitCode = 1;
    }

    if (!runOnce) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  } while (!runOnce);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
