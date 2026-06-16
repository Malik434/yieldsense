import { ethers } from 'ethers';
import {
  markYieldLeaseForDeployment,
  markYieldProcessorAuthorized,
  markYieldProcessorRevoked,
  recordYieldDeploymentStarted,
  recordYieldProcessorTelemetry,
  setYieldLeaseEnabled,
  YIELD_LEASE_EXECUTION_INTERVAL_MS,
  YIELD_LEASE_NUMBER_OF_EXECUTIONS,
  type YieldProcessorLease,
  type YieldProcessorTelemetry,
} from './yieldProcessorLease';
import { deployAcurastProcessor, type AcurastDeploymentRequest } from './acurastDeploymentAdapter';
import { getYieldProcessorLease, saveYieldProcessorLease } from './yieldProcessorLeaseRepository';

const EXECUTOR_REGISTRY_ABI = [
  'function YIELD_EXECUTOR() view returns (bytes32)',
  'function registerProcessor(address processor, bytes32 role, bytes32 deploymentHash, bytes32 codeHash) external',
  'function revokeProcessor(address processor, bytes32 role) external',
  'function isAuthorized(address processor, bytes32 role) view returns (bool)',
];

type DeploymentResponse = {
  deploymentId: string;
};

export type YieldOrchestratorResult = {
  lease: YieldProcessorLease;
  action:
    | 'none'
    | 'disabled'
    | 'deployment_requested'
    | 'deployment_waiting_for_adapter'
    | 'processor_authorized'
    | 'failed';
  message?: string;
};

function serverNow() {
  return new Date();
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function requestAcurastDeployment(request: AcurastDeploymentRequest): Promise<DeploymentResponse | null> {
  const directDeployment = await deployAcurastProcessor('yield', request);
  if (directDeployment) return { deploymentId: directDeployment.deploymentId };

  const url = process.env.ACURAST_YIELD_DEPLOYMENT_WEBHOOK_URL?.trim();
  if (!url) return null;

  const secret = process.env.ACURAST_YIELD_DEPLOYMENT_WEBHOOK_SECRET?.trim();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Acurast yield deployment webhook failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  if (!body?.deploymentId || typeof body.deploymentId !== 'string') {
    throw new Error('Acurast yield deployment webhook did not return deploymentId');
  }

  return { deploymentId: body.deploymentId };
}

function getRegistrySigner(chainId: number) {
  const rpcUrl =
    chainId === 8453
      ? process.env.MAINNET_RPC_URL || process.env.NEXT_PUBLIC_MAINNET_RPC_URL || process.env.RPC_URL
      : process.env.TESTNET_RPC_URL || process.env.NEXT_PUBLIC_TESTNET_RPC_URL || process.env.RPC_URL;
  const privateKey = requireEnv('EXECUTOR_REGISTRY_OWNER_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(rpcUrl || 'https://mainnet.base.org', chainId);
  return new ethers.Wallet(privateKey, provider);
}

function getRegistryAddress() {
  return (
    process.env.EXECUTOR_REGISTRY_ADDRESS ||
    process.env.NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS ||
    ''
  ).trim();
}

function zeroHashIfMissing(value?: string) {
  return value && ethers.isHexString(value, 32) ? value : ethers.ZeroHash;
}

async function ensureYieldProcessorAuthorized(args: {
  chainId: number;
  processorAddress: string;
  deploymentHash?: string;
  codeHash?: string;
}) {
  const registryAddress = getRegistryAddress();
  if (!registryAddress) throw new Error('EXECUTOR_REGISTRY_ADDRESS is required for yield processor authorization');

  const signer = getRegistrySigner(args.chainId);
  const registry = new ethers.Contract(registryAddress, EXECUTOR_REGISTRY_ABI, signer);
  const role = await registry.YIELD_EXECUTOR();
  const alreadyAuthorized = await registry.isAuthorized(args.processorAddress, role);
  if (alreadyAuthorized) return { txHash: undefined, alreadyAuthorized: true };

  const tx = await registry.registerProcessor(
    args.processorAddress,
    role,
    zeroHashIfMissing(args.deploymentHash),
    zeroHashIfMissing(args.codeHash),
    { gasLimit: 180_000 }
  );
  await tx.wait();
  return { txHash: tx.hash as string, alreadyAuthorized: false };
}

async function revokeYieldProcessor(args: { chainId: number; processorAddress: string }) {
  const registryAddress = getRegistryAddress();
  if (!registryAddress) throw new Error('EXECUTOR_REGISTRY_ADDRESS is required for yield processor revocation');

  const signer = getRegistrySigner(args.chainId);
  const registry = new ethers.Contract(registryAddress, EXECUTOR_REGISTRY_ABI, signer);
  const role = await registry.YIELD_EXECUTOR();
  const alreadyAuthorized = await registry.isAuthorized(args.processorAddress, role);
  if (!alreadyAuthorized) return { txHash: undefined, skipped: true };

  const tx = await registry.revokeProcessor(args.processorAddress, role, { gasLimit: 100_000 });
  await tx.wait();
  return { txHash: tx.hash as string, skipped: false };
}

export async function setYieldProcessorOrchestrationEnabled(chainId: number, enabled: boolean) {
  const lease = setYieldLeaseEnabled(await getYieldProcessorLease(chainId), enabled, serverNow());
  return saveYieldProcessorLease(lease);
}

export async function reconcileYieldProcessorLease(chainId: number): Promise<YieldOrchestratorResult> {
  const now = serverNow();
  let lease = markYieldLeaseForDeployment(await getYieldProcessorLease(chainId), now);

  if (!lease.enabled || lease.state === 'disabled') {
    lease = await saveYieldProcessorLease(lease);
    return { lease, action: 'disabled' };
  }

  if (lease.state !== 'deploying' && lease.state !== 'updating') {
    lease = await saveYieldProcessorLease(lease);
    return { lease, action: 'none' };
  }

  try {
    const deployment = await requestAcurastDeployment({
      chainId,
      leaseEpoch: lease.leaseEpoch,
      intervalInMs: YIELD_LEASE_EXECUTION_INTERVAL_MS,
      numberOfExecutions: YIELD_LEASE_NUMBER_OF_EXECUTIONS,
      mutability: 'Mutable',
      restartPolicy: 'onFailure',
      reuseKeysFrom: lease.reuseKeysFrom,
    });

    if (!deployment) {
      lease = await saveYieldProcessorLease(lease);
      return {
        lease,
        action: 'deployment_waiting_for_adapter',
        message: 'Set ACURAST_YIELD_DEPLOYMENT_WEBHOOK_URL to enable automatic Acurast deployment.',
      };
    }

    lease = await saveYieldProcessorLease(recordYieldDeploymentStarted(lease, deployment.deploymentId, now));
    return { lease, action: 'deployment_requested' };
  } catch (error) {
    lease = await saveYieldProcessorLease({
      ...lease,
      state: 'failed',
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: now.toISOString(),
    });
    return { lease, action: 'failed', message: lease.lastError };
  }
}

export async function processYieldProcessorTelemetry(
  chainId: number,
  telemetry: YieldProcessorTelemetry & { deploymentHash?: string; codeHash?: string }
): Promise<YieldOrchestratorResult> {
  const now = serverNow();
  let lease = recordYieldProcessorTelemetry(await getYieldProcessorLease(chainId), telemetry, now);

  if (!lease.enabled) {
    lease = await saveYieldProcessorLease(lease);
    return { lease, action: 'disabled' };
  }

  if (!lease.pendingProcessorAddress || !lease.pendingDeploymentId) {
    lease = await saveYieldProcessorLease(lease);
    return { lease, action: 'none' };
  }

  try {
    const authorization = await ensureYieldProcessorAuthorized({
      chainId,
      processorAddress: lease.pendingProcessorAddress,
      deploymentHash: telemetry.deploymentHash,
      codeHash: telemetry.codeHash,
    });

    const oldProcessor = lease.currentProcessorAddress;
    const oldDeployment = lease.currentDeploymentId;
    lease = markYieldProcessorAuthorized(
      lease,
      {
        deploymentId: lease.pendingDeploymentId,
        processorAddress: lease.pendingProcessorAddress,
        txHash: authorization.txHash,
        reason: authorization.alreadyAuthorized ? 'processor_already_authorized' : 'processor_identity_reported',
      },
      now
    );

    if (oldProcessor && oldProcessor.toLowerCase() !== lease.currentProcessorAddress?.toLowerCase()) {
      const revocation = await revokeYieldProcessor({ chainId, processorAddress: oldProcessor });
      lease = markYieldProcessorRevoked(
        lease,
        {
          deploymentId: oldDeployment ?? 'unknown',
          processorAddress: oldProcessor,
          txHash: revocation.txHash,
          reason: revocation.skipped ? 'old_processor_already_inactive' : 'replacement_processor_authorized',
        },
        now
      );
    }

    lease = await saveYieldProcessorLease(lease);
    return { lease, action: 'processor_authorized' };
  } catch (error) {
    lease = await saveYieldProcessorLease({
      ...lease,
      state: 'failed',
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: now.toISOString(),
    });
    return { lease, action: 'failed', message: lease.lastError };
  }
}
