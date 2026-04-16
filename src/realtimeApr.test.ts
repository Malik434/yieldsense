import test from "node:test";
import assert from "node:assert/strict";
import { buildAprConsensus, type AprObservation } from "./realtimeApr.js";

// --- TC_APR_01 ---
test("buildAprConsensus filters out stale and outlier values", () => {
  const now = Math.floor(Date.now() / 1000);
  const observations: AprObservation[] = [
    { source: "geckoTerminal", apr: 0.2, timestamp: now, confidence: 0.9 },
    { source: "dexScreener", apr: 0.19, timestamp: now, confidence: 0.8 },
    { source: "defiLlama", apr: 1.5, timestamp: now, confidence: 0.7 },
  ];

  const result = buildAprConsensus(observations, 60, 0.4);
  assert.equal(result.usable, true);
  assert.ok(result.apr !== null);
  assert.ok((result.apr as number) < 0.3);
});

// --- TC_APR_03 ---
test("buildAprConsensus becomes unusable when all observations are stale", () => {
  const now = Math.floor(Date.now() / 1000);
  const observations: AprObservation[] = [
    { source: "geckoTerminal", apr: 0.2, timestamp: now - 9999, confidence: 0.9 },
    { source: "dexScreener", apr: 0.19, timestamp: now - 9999, confidence: 0.8 },
    { source: "defiLlama", apr: 0.18, timestamp: now - 9999, confidence: 0.7 },
  ];

  const result = buildAprConsensus(observations, 1200, 0.5);
  assert.equal(result.usable, false);
  assert.equal(result.apr, null);
});

// --- TC_APR_02 ---
test("buildAprConsensus remains usable when one source has null APR", () => {
  const now = Math.floor(Date.now() / 1000);
  const observations: AprObservation[] = [
    { source: "geckoTerminal", apr: 0.25, timestamp: now, confidence: 0.9 },
    { source: "dexScreener", apr: 0.24, timestamp: now, confidence: 0.85 },
    { source: "defiLlama", apr: null, timestamp: now, confidence: 0, error: "Pool not found" },
  ];

  const result = buildAprConsensus(observations, 300, 0.5);
  assert.equal(result.usable, true);
  assert.ok(result.apr !== null);
  assert.ok((result.apr as number) > 0.2 && (result.apr as number) < 0.3);
});

// --- TC_APR_04 ---
test("buildAprConsensus weighted average skews toward higher-confidence sources", () => {
  const now = Math.floor(Date.now() / 1000);
  const observations: AprObservation[] = [
    { source: "geckoTerminal", apr: 0.30, timestamp: now, confidence: 0.9 },
    { source: "dexScreener", apr: 0.10, timestamp: now, confidence: 0.1 },
  ];

  const result = buildAprConsensus(observations, 300, 0.3);
  assert.equal(result.usable, true);
  assert.ok(result.apr !== null);
  assert.ok((result.apr as number) > 0.25, "High-confidence 0.30 should dominate weighted average");
});

test("buildAprConsensus is unusable when all sources have null APR", () => {
  const now = Math.floor(Date.now() / 1000);
  const observations: AprObservation[] = [
    { source: "geckoTerminal", apr: null, timestamp: now, confidence: 0, error: "timeout" },
    { source: "dexScreener", apr: null, timestamp: now, confidence: 0, error: "timeout" },
    { source: "defiLlama", apr: null, timestamp: now, confidence: 0, error: "timeout" },
  ];

  const result = buildAprConsensus(observations, 300, 0.5);
  assert.equal(result.usable, false);
  assert.equal(result.apr, null);
  assert.equal(result.confidence, 0);
});

test("buildAprConsensus exposes original observations regardless of filtering", () => {
  const now = Math.floor(Date.now() / 1000);
  const observations: AprObservation[] = [
    { source: "geckoTerminal", apr: 0.2, timestamp: now, confidence: 0.9 },
    { source: "dexScreener", apr: 0.2, timestamp: now, confidence: 0.8 },
  ];

  const result = buildAprConsensus(observations, 300, 0.5);
  assert.equal(result.observations.length, 2);
});
