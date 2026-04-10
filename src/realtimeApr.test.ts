import test from "node:test";
import assert from "node:assert/strict";
import { buildAprConsensus, type AprObservation } from "./realtimeApr.js";

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
