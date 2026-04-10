import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { buildPayloadHash, signHarvestPayload, verifyPayloadSigner } from "./signature.js";

test("signature payload verifies against expected worker", () => {
  const wallet = ethers.Wallet.createRandom();
  const payloadHash = buildPayloadHash(wallet.address, wallet.address, 1200, 550, 1711111111);
  const signed = signHarvestPayload(wallet.privateKey, payloadHash);
  const valid = verifyPayloadSigner(wallet.address, payloadHash, signed.r, signed.s, signed.v);
  assert.equal(valid, true);
});

test("signature payload fails for unauthorized worker", () => {
  const wallet = ethers.Wallet.createRandom();
  const unauthorized = ethers.Wallet.createRandom();
  const payloadHash = buildPayloadHash(wallet.address, wallet.address, 1200, 550, 1711111111);
  const signed = signHarvestPayload(wallet.privateKey, payloadHash);
  const valid = verifyPayloadSigner(unauthorized.address, payloadHash, signed.r, signed.s, signed.v);
  assert.equal(valid, false);
});

test("payload hash replay marker can be tracked by key", () => {
  const wallet = ethers.Wallet.createRandom();
  const payloadHash = buildPayloadHash(wallet.address, wallet.address, 1000, 200, 1700000000);
  const usedPayload = new Set<string>();
  assert.equal(usedPayload.has(payloadHash), false);
  usedPayload.add(payloadHash);
  assert.equal(usedPayload.has(payloadHash), true);
});
