import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ethers } from "ethers";

type StorageRecord = Record<string, string>;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for local Acurast smoke execution.`);
  }
  return value;
}

function parseStorage(filePath: string): StorageRecord {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StorageRecord)
      : {};
  } catch {
    return {};
  }
}

function persistStorage(filePath: string, storage: StorageRecord): void {
  writeFileSync(filePath, JSON.stringify(storage, null, 2), "utf8");
}

function parseBigIntExtra(extra: Record<string, string | undefined>, key: string): bigint | undefined {
  const value = extra[key]?.trim();
  return value ? BigInt(value) : undefined;
}

function requireBigIntExtra(extra: Record<string, string | undefined>, key: string): bigint {
  const value = parseBigIntExtra(extra, key);
  if (value === undefined) {
    throw new Error(`Acurast fulfill ${key} is required for local transaction signing.`);
  }
  return value;
}

function installLocalAcurastStd(): void {
  const privateKey = requiredEnv("ACURAST_WORKER_KEY");
  const wallet = new ethers.Wallet(privateKey);
  const storagePath =
    process.env.LOCAL_ACURAST_STORAGE_PATH?.trim() ||
    join(tmpdir(), "yieldsense-local-acurast-storage.json");
  const storage = parseStorage(storagePath);

  (globalThis as any)._STD_ = {
    signers: {
      secp256k1: {
        sign: (payloadHex: string) => {
          const digest = payloadHex.startsWith("0x") ? payloadHex : `0x${payloadHex}`;
          return wallet.signingKey.sign(digest).serialized;
        },
      },
    },
    chains: {
      ethereum: {
        getAddress: () => wallet.address,
        fulfill: async (
          url: string,
          destination: string,
          payload: string,
          extra: Record<string, string | undefined>,
          success: (operationHash: string) => void,
          error: (messages: string[]) => void
        ) => {
          try {
            const methodSignature = extra.methodSignature;
            if (!methodSignature) {
              throw new Error("Acurast fulfill methodSignature is required.");
            }

            const chainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 8453;
            const provider = new ethers.JsonRpcProvider(url, chainId, {
              batchMaxCount: 1,
              staticNetwork: true,
            });
            const selector = ethers.id(methodSignature).slice(0, 10);
            const data = `${selector}${payload.replace(/^0x/, "")}`;

            if (!ethers.isHexString(data)) {
              throw new Error(`Acurast fulfill calldata is not valid hex: ${data.length - 2} hex chars.`);
            }

            const nonce = await provider.getTransactionCount(wallet.address, "pending");
            const rawTransaction = await wallet.signTransaction({
              type: 2,
              chainId,
              nonce,
              to: ethers.getAddress(destination),
              data,
              value: 0n,
              gasLimit: requireBigIntExtra(extra, "gasLimit"),
              maxFeePerGas: requireBigIntExtra(extra, "maxFeePerGas"),
              maxPriorityFeePerGas: requireBigIntExtra(extra, "maxPriorityFeePerGas"),
            });

            const rawHexLength = rawTransaction.length - 2;
            if (!ethers.isHexString(rawTransaction) || rawHexLength % 2 !== 0) {
              throw new Error(`Acurast fulfill signed transaction is invalid hex: ${rawHexLength} hex chars.`);
            }

            const parsedTransaction = ethers.Transaction.from(rawTransaction);
            console.log(
              `[LOCAL_ACURAST_STD] Broadcasting raw tx ${parsedTransaction.hash} ` +
                `nonce=${nonce} bytes=${rawHexLength / 2} selector=${selector}`
            );

            const tx = await provider.broadcastTransaction(rawTransaction);
            success(tx.hash);
          } catch (err) {
            error([err instanceof Error ? err.message : String(err)]);
          }
        },
      },
    },
    storage: {
      get: (key: string) => storage[key] ?? null,
      set: (key: string, value: string) => {
        storage[key] = value;
        persistStorage(storagePath, storage);
      },
      remove: (key: string) => {
        delete storage[key];
        persistStorage(storagePath, storage);
      },
    },
  };

  console.log(`[LOCAL_ACURAST_STD] Installed local _STD_ for ${wallet.address}`);
  console.log(`[LOCAL_ACURAST_STD] Storage path: ${storagePath}`);
}

installLocalAcurastStd();
await import("../src/index.js");
