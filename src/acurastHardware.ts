import { ethers } from "ethers";
import type { HarvestSignaturePayload } from "./signature.js";

/** Minimal typing for the processor-injected `_STD_` global (Acurast runtime ≥ 1.9.2). */
export interface AcurastStd {
  signers: {
    secp256k1: { sign: (payloadHex: string) => string };
  };
  chains: {
    ethereum: {
      getAddress: () => string;
      fulfill: (
        url: string,
        destination: string,
        payload: string,
        extra: Record<string, string | undefined>,
        success: (operationHash: string) => void,
        error: (messages: string[]) => void
      ) => void;
    };
  };
  /** Persistent key-value store local to this Acurast processor device. */
  storage: {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
    remove: (key: string) => void;
  };
}

export function getAcurastStd(): AcurastStd | undefined {
  const g = globalThis as unknown as { _STD_?: AcurastStd };
  const std = g._STD_;
  if (!std?.signers?.secp256k1?.sign || !std?.chains?.ethereum?.fulfill || !std?.chains?.ethereum?.getAddress) {
    return undefined;
  }
  return std;
}

/**
 * Safely get a JSON value from `_STD_.storage`, returning `fallback` on miss or parse error.
 */
export function storageGet<T>(std: AcurastStd, key: string, fallback: T): T {
  try {
    const raw = std.storage.get(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Safely set a JSON value in `_STD_.storage`. */
export function storageSet(std: AcurastStd, key: string, value: unknown): void {
  std.storage.set(key, JSON.stringify(value));
}

/**
 * Infer Ethereum-style `v` (27 or 28) for a digest signed with ECDSA secp256k1.
 */
export function inferEthereumV(
  digestHex: string,
  r: string,
  s: string,
  expectedSigner: string
): number {
  const want = expectedSigner.toLowerCase();
  for (const v of [27, 28] as const) {
    try {
      if (ethers.recoverAddress(digestHex, { r, s, v }).toLowerCase() === want) {
        return v;
      }
    } catch {
      /* invalid (r,s,v) for this curve */
    }
  }
  throw new Error("Hardware signature does not recover to the deployment Ethereum address");
}

/**
 * Parse `_STD_.signers.secp256k1.sign` hex output into (r, s, v).
 * Supports 64-byte compact (r||s) or 65-byte compact with recovery id / Ethereum v.
 */
export function parseSecp256k1SignOutput(
  digestHex: string,
  sigHex: string,
  expectedSigner: string
): Pick<HarvestSignaturePayload, "r" | "s" | "v"> {
  const normalized = sigHex.startsWith("0x") ? sigHex : `0x${sigHex}`;
  const bytes = ethers.getBytes(normalized);

  if (bytes.length === 64) {
    const r = ethers.hexlify(bytes.slice(0, 32));
    const s = ethers.hexlify(bytes.slice(32, 64));
    const v = inferEthereumV(digestHex, r, s, expectedSigner);
    return { r, s, v };
  }

  if (bytes.length >= 65) {
    const r = ethers.hexlify(bytes.slice(0, 32));
    const s = ethers.hexlify(bytes.slice(32, 64));
    let v = Number(bytes[64]);
    if (v === 0 || v === 1) {
      v += 27;
    }
    if (ethers.recoverAddress(digestHex, { r, s, v }).toLowerCase() !== expectedSigner.toLowerCase()) {
      const vAlt = v === 27 ? 28 : 27;
      if (ethers.recoverAddress(digestHex, { r, s, v: vAlt }).toLowerCase() === expectedSigner.toLowerCase()) {
        return { r, s, v: vAlt };
      }
      throw new Error("Hardware signature recovery id does not match deployment Ethereum address");
    }
    return { r, s, v };
  }

  throw new Error(
    `Unexpected secp256k1 signature length: ${bytes.length} bytes (expected 64 or 65+). ` +
      "If the runtime returns DER encoding, add a DER parser here."
  );
}

export function signHarvestPayloadWithAcurastHardware(
  std: AcurastStd,
  payloadHash: string,
  expectedSigner: string
): HarvestSignaturePayload {
  // Use ethers.hashMessage to add the "\x19Ethereum Signed Message:\n32" prefix
  // so it matches the contract's MessageHashUtils.toEthSignedMessageHash(digest).
  const ethDigest = ethers.hashMessage(ethers.getBytes(payloadHash));
  const sigHex = std.signers.secp256k1.sign(ethDigest.replace(/^0x/, ""));
  
  const { r, s, v } = parseSecp256k1SignOutput(ethDigest, sigHex, expectedSigner);
  return { payloadHash, r, s, v };
}

const EXECUTE_HARVEST_MODERN = "executeHarvest(bytes32,bytes32,bytes32,uint8,uint256)";

function encodeExecuteHarvestArgs(
  payloadHash: string, r: string, s: string, v: number, minAssetOut: bigint
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes32", "uint8", "uint256"],
    [payloadHash, r, s, v, minAssetOut]
  );
}

/**
 * Submits an Ethereum contract call signed and broadcast by the processor (no local private key).
 */
export function fulfillEthereumHarvest(
  std: AcurastStd,
  params: {
    rpcUrl: string;
    keeperAddress: string;
    payloadHash: string;
    r: string;
    s: string;
    v: number;
    /** Minimum USDC (6 dec) to accept from AERO→USDC swap inside the autocompounder. */
    minAssetOut: bigint;
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }
): Promise<{ hash: string }> {
  const payload = encodeExecuteHarvestArgs(
    params.payloadHash, params.r, params.s, params.v, params.minAssetOut
  );
  return new Promise((resolve, reject) => {
    std.chains.ethereum.fulfill(
      params.rpcUrl,
      params.keeperAddress,
      payload,
      {
        methodSignature: EXECUTE_HARVEST_MODERN,
        gasLimit: params.gasLimit,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      },
      (operationHash: string) => resolve({ hash: operationHash }),
      (messages: string[]) => reject(new Error(messages.join("; ")))
    );
  });
}
