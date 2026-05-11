import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { inferEthereumV, parseSecp256k1SignOutput } from "./acurastHardware.js";

function randomDigest(): string {
  return ethers.keccak256(ethers.randomBytes(32));
}

test("inferEthereumV finds v for raw secp256k1 digest signature", () => {
  const wallet = ethers.Wallet.createRandom();
  const digest = randomDigest();
  const sig = wallet.signingKey.sign(digest);
  const v = inferEthereumV(digest, sig.r, sig.s, wallet.address);
  assert.equal(v, sig.yParity + 27);
  assert.equal(
    ethers.recoverAddress(digest, { r: sig.r, s: sig.s, v }).toLowerCase(),
    wallet.address.toLowerCase()
  );
});

test("parseSecp256k1SignOutput accepts 65-byte compact (yParity + 27)", () => {
  const wallet = ethers.Wallet.createRandom();
  const digest = randomDigest();
  const sig = wallet.signingKey.sign(digest);
  const vByte = sig.yParity + 27;
  const compact = ethers.concat([sig.r, sig.s, Uint8Array.of(vByte)]);
  const parsed = parseSecp256k1SignOutput(digest, ethers.hexlify(compact), wallet.address);
  assert.equal(parsed.r, sig.r);
  assert.equal(parsed.s, sig.s);
  assert.equal(parsed.v, vByte);
});

test("parseSecp256k1SignOutput accepts 64-byte compact and recovers v", () => {
  const wallet = ethers.Wallet.createRandom();
  const digest = randomDigest();
  const sig = wallet.signingKey.sign(digest);
  const compact64 = ethers.concat([sig.r, sig.s]);
  const parsed = parseSecp256k1SignOutput(digest, ethers.hexlify(compact64), wallet.address);
  assert.equal(parsed.v, sig.yParity + 27);
});
