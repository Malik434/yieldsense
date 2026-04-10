import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultState, loadState, saveState } from "./runtimeState.js";

test("loadState returns defaults when file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yieldsense-state-"));
  const statePath = join(dir, "missing.json");
  const state = await loadState(statePath);
  assert.deepEqual(state, defaultState);
  await rm(dir, { recursive: true, force: true });
});

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
