import { ethers } from "ethers";

export interface HarvestSignaturePayload {
  payloadHash: string;
  r: string;
  s: string;
  v: number;
}

export function buildPayloadHash(
  keeperAddress: string,
  poolAddress: string,
  aprBps: number,
  netRewardCents: number,
  timestampSec: number
): string {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint256", "uint256", "uint256"],
    [keeperAddress, poolAddress, aprBps, netRewardCents, timestampSec]
  );
}

export function signHarvestPayload(privateKey: string, payloadHash: string): HarvestSignaturePayload {
  const wallet = new ethers.Wallet(privateKey);
  const signature = wallet.signingKey.sign(payloadHash);
  return {
    payloadHash,
    r: signature.r,
    s: signature.s,
    v: signature.yParity + 27,
  };
}

export function verifyPayloadSigner(
  expectedSigner: string,
  payloadHash: string,
  r: string,
  s: string,
  v: number
): boolean {
  const recovered = ethers.recoverAddress(payloadHash, { r, s, v });
  return recovered.toLowerCase() === expectedSigner.toLowerCase();
}
