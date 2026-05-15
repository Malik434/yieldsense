import { ethers } from "ethers";
import {
  createPublicClient,
  encodeFunctionData,
  hashMessage,
  http,
  type Address,
  type Hex,
  type SignableMessage,
  type TransactionReceipt,
} from "viem";
import { createBundlerClient, toCoinbaseSmartAccount } from "viem/account-abstraction";
import { base } from "viem/chains";
import type { TypedDataDefinition } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { getAcurastStd, parseSecp256k1SignOutput, type AcurastStd } from "./acurastHardware.js";

const EXECUTE_HARVEST_ABI = [
  {
    type: "function",
    name: "executeHarvest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "nonce", type: "uint256" },
      { name: "targetPool", type: "address" },
      { name: "minLpOut", type: "uint256" },
      { name: "amountToSwap", type: "uint256" },
      { name: "deadline", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

function timeoutEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function signDigest(std: AcurastStd, digest: Hex, expectedSigner: Address): Hex {
  const sigHex = std.signers.secp256k1.sign(digest.replace(/^0x/, ""));
  const parsed = parseSecp256k1SignOutput(digest, sigHex, expectedSigner);
  return ethers.Signature.from(parsed).serialized as Hex;
}

function typedDataDigest(parameters: TypedDataDefinition): Hex {
  const { domain, message } = parameters as any;
  const allTypes = { ...((parameters as any).types ?? {}) };
  delete allTypes.EIP712Domain;
  return ethers.TypedDataEncoder.hash(domain ?? {}, allTypes, message) as Hex;
}

function messageDigest(message: SignableMessage): Hex {
  return hashMessage(message) as Hex;
}

export function getPaymasterRpcUrl(): string | undefined {
  return (
    process.env.BASE_PAYMASTER_RPC_URL?.trim() ||
    process.env.PAYMASTER_RPC_URL?.trim() ||
    (globalThis as any).__ENV__?.BASE_PAYMASTER_RPC_URL ||
    (globalThis as any).__ENV__?.PAYMASTER_RPC_URL
  );
}

export function getPaymasterOwnerPrivateKey(): Hex | undefined {
  const raw =
    process.env.PAYMASTER_OWNER_PRIVATE_KEY?.trim() ||
    (globalThis as any).__ENV__?.PAYMASTER_OWNER_PRIVATE_KEY;
  if (!raw) return undefined;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

export function getPaymasterOwnerMode(): "stable_private_key" | "acurast_hardware_eoa" {
  return getPaymasterOwnerPrivateKey() ? "stable_private_key" : "acurast_hardware_eoa";
}

export function createAcurastOwnerAccount(std: AcurastStd = getAcurastStd()!): LocalAccount<"acurast"> {
  if (!std) throw new Error("Acurast _STD_ is required for paymaster smart-account signing.");

  const address = ethers.getAddress(std.chains.ethereum.getAddress()) as Address;
  return {
    address,
    publicKey: "0x",
    source: "acurast",
    type: "local",
    async sign({ hash }) {
      return signDigest(std, hash as Hex, address);
    },
    async signMessage({ message }) {
      return signDigest(std, messageDigest(message), address);
    },
    async signTypedData(parameters) {
      return signDigest(std, typedDataDigest(parameters as TypedDataDefinition), address);
    },
    async signTransaction() {
      throw new Error("Acurast paymaster account cannot sign raw EOA transactions.");
    },
  };
}

export function createPaymasterOwnerAccount(std?: AcurastStd): LocalAccount {
  const stablePrivateKey = getPaymasterOwnerPrivateKey();
  if (stablePrivateKey) {
    return privateKeyToAccount(stablePrivateKey);
  }
  return createAcurastOwnerAccount(std);
}

export async function getAcurastPaymasterSmartAccountAddress(params: {
  rpcUrl: string;
  std?: AcurastStd;
}): Promise<Address> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(params.rpcUrl, { timeout: timeoutEnv("PAYMASTER_PUBLIC_RPC_TIMEOUT_MS", 10_000) }),
  });
  const account = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [createPaymasterOwnerAccount(params.std)],
    version: "1.1",
  });
  return account.address;
}

export async function submitHarvestWithBasePaymaster(params: {
  std: AcurastStd;
  rpcUrl: string;
  paymasterRpcUrl: string;
  keeperAddress: string;
  nonce: string;
  targetPool: string;
  minLpOut: string;
  amountToSwap: string;
  deadline: number;
  routes: readonly {
    from: string;
    to: string;
    stable: boolean;
    factory: string;
  }[];
}): Promise<{
  hash: string;
  userOpHash: string;
  smartAccountAddress: string;
  receipt: TransactionReceipt;
}> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(params.rpcUrl, { timeout: timeoutEnv("PAYMASTER_PUBLIC_RPC_TIMEOUT_MS", 10_000) }),
  });
  const account = await toCoinbaseSmartAccount({
    client: publicClient,
    owners: [createPaymasterOwnerAccount(params.std)],
    version: "1.1",
  });
  const bundlerClient = createBundlerClient({
    account,
    chain: base,
    client: publicClient,
    transport: http(params.paymasterRpcUrl, { timeout: timeoutEnv("PAYMASTER_RPC_TIMEOUT_MS", 20_000) }),
    paymaster: true,
    pollingInterval: timeoutEnv("PAYMASTER_POLLING_INTERVAL_MS", 2_000),
  });

  const data = encodeFunctionData({
    abi: EXECUTE_HARVEST_ABI,
    functionName: "executeHarvest",
    args: [
      BigInt(params.nonce),
      ethers.getAddress(params.targetPool) as Address,
      BigInt(params.minLpOut),
      BigInt(params.amountToSwap),
      BigInt(params.deadline),
      params.routes.map((route) => ({
        from: ethers.getAddress(route.from) as Address,
        to: ethers.getAddress(route.to) as Address,
        stable: route.stable,
        factory: ethers.getAddress(route.factory) as Address,
      })),
    ],
  });

  const userOpHash = await bundlerClient.sendUserOperation({
    account,
    calls: [
      {
        to: ethers.getAddress(params.keeperAddress) as Address,
        value: 0n,
        data,
      },
    ],
  });
  const userOpReceipt = await bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: timeoutEnv("PAYMASTER_WAIT_TIMEOUT_MS", 120_000),
  });
  if (!userOpReceipt.success) {
    throw new Error(`Sponsored harvest user operation reverted: ${userOpReceipt.reason ?? userOpHash}`);
  }

  return {
    hash: userOpReceipt.receipt.transactionHash,
    userOpHash,
    smartAccountAddress: account.address,
    receipt: userOpReceipt.receipt,
  };
}
