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
import {
  emptyGridProcessorLease,
  markGridLeaseCandidates,
  markGridProcessorAuthorized,
  recordGridDeploymentStarted,
  recordGridProcessorTelemetry,
  shouldRenewGridLease,
} from "../frontend/src/lib/gridProcessorLease.js";

const GRID_LEASE_TEST_NOW = new Date("2026-06-11T00:00:00.000Z");
const GRID_PROCESSOR_A = "0x0000000000000000000000000000000000000001";
const GRID_PROCESSOR_B = "0x0000000000000000000000000000000000000002";

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

test("grid lease spawns when active strategies transition from zero to one", () => {
  const lease = emptyGridProcessorLease(8453, GRID_LEASE_TEST_NOW);
  const next = markGridLeaseCandidates(lease, ["0xstrategy"], GRID_LEASE_TEST_NOW);

  assert.equal(next.state, "deploying");
  assert.equal(next.leaseEpoch, 1);
  assert.deepEqual(next.activeStrategyIds, ["0xstrategy"]);
});

test("grid lease drains when there are no active strategy candidates", () => {
  const active = {
    ...emptyGridProcessorLease(8453, GRID_LEASE_TEST_NOW),
    state: "active" as const,
    currentDeploymentId: "Acurast:5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL:123",
    currentProcessorAddress: GRID_PROCESSOR_A,
  };

  const next = markGridLeaseCandidates(active, [], GRID_LEASE_TEST_NOW);
  assert.equal(next.state, "draining");
  assert.deepEqual(next.activeStrategyIds, []);
});

test("new grid processor identity remains pending until explicitly authorized", () => {
  const deployment = recordGridDeploymentStarted(
    markGridLeaseCandidates(emptyGridProcessorLease(8453, GRID_LEASE_TEST_NOW), ["0xstrategy"], GRID_LEASE_TEST_NOW),
    "Acurast:5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL:124",
    GRID_LEASE_TEST_NOW
  );

  const reported = recordGridProcessorTelemetry(deployment, {
    deploymentId: deployment.pendingDeploymentId,
    processorAddress: GRID_PROCESSOR_B,
    leaseEpoch: deployment.leaseEpoch,
    healthy: true,
  }, GRID_LEASE_TEST_NOW);

  assert.equal(reported.state, "deploying");
  assert.equal(reported.pendingProcessorAddress, GRID_PROCESSOR_B);
  assert.equal(reported.currentProcessorAddress, undefined);

  const authorized = markGridProcessorAuthorized(reported, {
    deploymentId: reported.pendingDeploymentId!,
    processorAddress: reported.pendingProcessorAddress!,
    txHash: "0xabc",
    reason: "processor_identity_reported",
  }, GRID_LEASE_TEST_NOW);

  assert.equal(authorized.state, "active");
  assert.equal(authorized.currentProcessorAddress, GRID_PROCESSOR_B);
  assert.equal(authorized.rotations[0].action, "register");
});

test("stale grid processor telemetry from an older lease epoch is ignored", () => {
  const lease = {
    ...emptyGridProcessorLease(8453, GRID_LEASE_TEST_NOW),
    state: "active" as const,
    leaseEpoch: 3,
    currentProcessorAddress: GRID_PROCESSOR_B,
  };

  const next = recordGridProcessorTelemetry(lease, {
    deploymentId: "Acurast:5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL:122",
    processorAddress: GRID_PROCESSOR_A,
    leaseEpoch: 2,
    healthy: true,
  }, GRID_LEASE_TEST_NOW);

  assert.equal(next.currentProcessorAddress, GRID_PROCESSOR_B);
  assert.equal(next.pendingProcessorAddress, undefined);
});

test("active grid leases enter update window twelve hours before expiry", () => {
  const lease = {
    ...emptyGridProcessorLease(8453, GRID_LEASE_TEST_NOW),
    state: "active" as const,
    leaseExpiresAt: new Date("2026-06-11T11:59:00.000Z").toISOString(),
  };

  assert.equal(shouldRenewGridLease(lease, GRID_LEASE_TEST_NOW), true);
});
