import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultState, loadState, saveState } from "./runtimeState.js";

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
