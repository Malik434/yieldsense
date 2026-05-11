import test from "node:test";
import assert from "node:assert/strict";
import { buildHarvestPayloadHash, type HarvestParams } from "./signature.js";

const ROUTE = {
  from: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  stable: false,
  factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
};

function params(overrides: Partial<HarvestParams> = {}): HarvestParams {
  return {
    nonce: "1778516843",
    targetPool: "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d",
    minLpOut: "1",
    amountToSwap: "5000000",
    deadline: 1778517143,
    routes: [ROUTE],
    ...overrides,
  };
}

test("harvest payload hash is deterministic for deployed executeHarvest calldata", () => {
  const payload = params();
  assert.equal(buildHarvestPayloadHash(payload), buildHarvestPayloadHash({ ...payload }));
});

test("harvest payload hash changes when replay nonce changes", () => {
  assert.notEqual(
    buildHarvestPayloadHash(params({ nonce: "1" })),
    buildHarvestPayloadHash(params({ nonce: "2" }))
  );
});

test("harvest payload hash changes when route changes", () => {
  assert.notEqual(
    buildHarvestPayloadHash(params()),
    buildHarvestPayloadHash(params({ routes: [{ ...ROUTE, stable: true }] }))
  );
});
