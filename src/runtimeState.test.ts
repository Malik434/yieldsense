import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultState, loadState, saveState } from "./runtimeState.js";
import {
  calculateRecentRunSkip,
  calculateSupervisorDelayMs,
  isProcessorNotAttestedError,
} from "./processorSupervisor.js";

// --- TC_STATE_01 ---
test("loadState returns defaults when file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldsense-state-"));
  const statePath = join(dir, "missing.json");
  const state = await loadState(statePath);
  assert.deepEqual(state, defaultState);
  await rm(dir, { recursive: true, force: true });
});

// --- TC_STATE_02 ---
test("saveState and loadState persist worker state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldsense-state-"));
  const statePath = join(dir, "state.json");

  await saveState(statePath, {
    previousApr: 0.22,
    apiFailureStreak: 2,
    lastDecisionReason: "apr_not_usable",
    lastRunAt: 1700000000,
    lastExecutionAt: 1699999990,
    suggestedNextCheckMs: 240000,
  });

  const persistedRaw = await readFile(statePath, "utf8");
  assert.ok(persistedRaw.includes("\"apiFailureStreak\": 2"));

  const loaded = await loadState(statePath);
  assert.equal(loaded.previousApr, 0.22);
  assert.equal(loaded.apiFailureStreak, 2);
  assert.equal(loaded.lastDecisionReason, "apr_not_usable");

  await rm(dir, { recursive: true, force: true });
});

test("saveState and loadState persist rewardAprEwm field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldsense-state-"));
  const statePath = join(dir, "state.json");

  await saveState(statePath, {
    previousApr: 0.15,
    apiFailureStreak: 0,
    lastDecisionReason: "profitable",
    lastRunAt: 1700000100,
    lastExecutionAt: 1700000050,
    suggestedNextCheckMs: 120000,
    rewardAprEwm: 0.42,
  });

  const loaded = await loadState(statePath);
  assert.equal(loaded.rewardAprEwm, 0.42);

  await rm(dir, { recursive: true, force: true });
});

test("saveState and loadState persist yieldIndexerCheckpointBlock field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldsense-state-"));
  const statePath = join(dir, "state.json");

  await saveState(statePath, {
    previousApr: 0.1,
    apiFailureStreak: 0,
    lastDecisionReason: "profitable",
    lastRunAt: 1700000200,
    lastExecutionAt: 1700000150,
    suggestedNextCheckMs: 120000,
    yieldIndexerCheckpointBlock: 19_500_000,
  });

  const loaded = await loadState(statePath);
  assert.equal(loaded.yieldIndexerCheckpointBlock, 19_500_000);

  await rm(dir, { recursive: true, force: true });
});

test("loadState merges new fields from defaultState when state file is partial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldsense-state-"));
  const statePath = join(dir, "state.json");

  // Write a partial state without the new optional fields
  const { writeFile } = await import("node:fs/promises");
  await writeFile(statePath, JSON.stringify({ previousApr: 0.3, apiFailureStreak: 1 }), "utf8");

  const loaded = await loadState(statePath);
  assert.equal(loaded.previousApr, 0.3);
  assert.equal(loaded.apiFailureStreak, 1);
  // Defaults should be filled in for missing keys
  assert.equal(loaded.lastDecisionReason, null);
  assert.equal(loaded.rewardAprEwm, null);
  assert.equal(loaded.yieldIndexerCheckpointBlock, null);

  await rm(dir, { recursive: true, force: true });
});

test("calculateRecentRunSkip returns the remaining delay instead of requiring exit-based scheduling", () => {
  const decision = calculateRecentRunSkip({
    runCooldownGuard: true,
    lastRunAt: 1_000,
    nowSec: 1_120,
    minRunIntervalMs: 60_000,
    suggestedNextCheckMs: 240_000,
  });

  assert.equal(decision.skip, true);
  assert.equal(decision.elapsedMs, 120_000);
  assert.equal(decision.intervalMs, 240_000);
  assert.equal(decision.waitMs, 120_000);
});

test("calculateSupervisorDelayMs preserves the configured minimum worker cadence", () => {
  assert.equal(calculateSupervisorDelayMs({ minRunIntervalMs: 600_000, suggestedNextCheckMs: 60_000 }), 600_000);
  assert.equal(calculateSupervisorDelayMs({ minRunIntervalMs: 60_000, suggestedNextCheckMs: 900_000 }), 900_000);
});

test("isProcessorNotAttestedError detects the keeper custom error selector", () => {
  assert.equal(isProcessorNotAttestedError({ data: "0x326c7612" }), true);
  assert.equal(isProcessorNotAttestedError(new Error("execution reverted: ProcessorNotAttested")), true);
  assert.equal(isProcessorNotAttestedError(new Error("network timeout")), false);
});
