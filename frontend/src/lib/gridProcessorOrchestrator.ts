import { ethers } from 'ethers';
import {
  GRID_LEASE_EXECUTION_INTERVAL_MS,
  GRID_LEASE_NUMBER_OF_EXECUTIONS,
  markGridLeaseCandidates,
  markGridProcessorAuthorized,
  markGridProcessorRevoked,
  recordGridDeploymentStarted,
  recordGridProcessorTelemetry,
  type AcurastDeploymentRef,
  type GridProcessorLease,
  type GridProcessorTelemetry,
} from './gridProcessorLease';
import { getGridProcessorLease, saveGridProcessorLease } from './gridProcessorLeaseRepository';
import { listActiveGridStrategyIds } from './gridStrategyRepository';

const EXECUTOR_REGISTRY_ABI = [
  'function GRID_EXECUTOR() view returns (bytes32)',
  'function registerProcessor(address processor, bytes32 role, bytes32 deploymentHash, bytes32 codeHash) external',
  'function revokeProcessor(address processor, bytes32 role) external',
  'function isAuthorized(address processor, bytes32 role) view returns (bool)',
];

type DeploymentRequest = {
  chainId: number;
  leaseEpoch: number;
  intervalInMs: number;
  numberOfExecutions: number;
  mutability: 'Mutable';
  restartPolicy: 'onFailure';
  reuseKeysFrom?: AcurastDeploymentRef;
};

type DeploymentResponse = {
  deploymentId: string;
};

export type GridOrchestratorResult = {
  lease: GridProcessorLease;
  action:
    | 'none'
    | 'draining'
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

async function requestAcurastDeployment(request: DeploymentRequest): Promise<DeploymentResponse | null> {
  const url = process.env.ACURAST_GRID_DEPLOYMENT_WEBHOOK_URL?.trim();
  if (!url) return null;

  const secret = process.env.ACURAST_GRID_DEPLOYMENT_WEBHOOK_SECRET?.trim();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Acurast deployment webhook failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  if (!body?.deploymentId || typeof body.deploymentId !== 'string') {
    throw new Error('Acurast deployment webhook did not return deploymentId');
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

async function ensureProcessorAuthorized(args: {
  chainId: number;
  processorAddress: string;
  deploymentHash?: string;
  codeHash?: string;
}) {
  const registryAddress = getRegistryAddress();
  if (!registryAddress) throw new Error('EXECUTOR_REGISTRY_ADDRESS is required for processor authorization');

  const signer = getRegistrySigner(args.chainId);
  const registry = new ethers.Contract(registryAddress, EXECUTOR_REGISTRY_ABI, signer);
  const role = await registry.GRID_EXECUTOR();
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

async function revokeProcessor(args: { chainId: number; processorAddress: string }) {
  const registryAddress = getRegistryAddress();
  if (!registryAddress) throw new Error('EXECUTOR_REGISTRY_ADDRESS is required for processor revocation');

  const signer = getRegistrySigner(args.chainId);
  const registry = new ethers.Contract(registryAddress, EXECUTOR_REGISTRY_ABI, signer);
  const role = await registry.GRID_EXECUTOR();
  const alreadyAuthorized = await registry.isAuthorized(args.processorAddress, role);
  if (!alreadyAuthorized) return { txHash: undefined, skipped: true };

  const tx = await registry.revokeProcessor(args.processorAddress, role, { gasLimit: 100_000 });
  await tx.wait();
  return { txHash: tx.hash as string, skipped: false };
}

export async function reconcileGridProcessorLease(chainId: number): Promise<GridOrchestratorResult> {
  const now = serverNow();
  const activeStrategyIds = await listActiveGridStrategyIds(chainId);
  const currentLease = await getGridProcessorLease(chainId);
  let lease = markGridLeaseCandidates(currentLease, activeStrategyIds, now);

  if (lease.state === 'draining' || lease.state === 'inactive') {
    lease = await saveGridProcessorLease(lease);
    return { lease, action: lease.state === 'draining' ? 'draining' : 'none' };
  }

  if (lease.state !== 'deploying') {
    lease = await saveGridProcessorLease(lease);
    return { lease, action: 'none' };
  }

  try {
    const deployment = await requestAcurastDeployment({
      chainId,
      leaseEpoch: lease.leaseEpoch,
      intervalInMs: GRID_LEASE_EXECUTION_INTERVAL_MS,
      numberOfExecutions: GRID_LEASE_NUMBER_OF_EXECUTIONS,
      mutability: 'Mutable',
      restartPolicy: 'onFailure',
      reuseKeysFrom: lease.reuseKeysFrom,
    });

    if (!deployment) {
      lease = await saveGridProcessorLease(lease);
      return {
        lease,
        action: 'deployment_waiting_for_adapter',
        message: 'Set ACURAST_GRID_DEPLOYMENT_WEBHOOK_URL to enable automatic Acurast deployment.',
      };
    }

    lease = await saveGridProcessorLease(recordGridDeploymentStarted(lease, deployment.deploymentId, now));
    return { lease, action: 'deployment_requested' };
  } catch (error) {
    lease = await saveGridProcessorLease({
      ...lease,
      state: 'failed',
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: now.toISOString(),
    });
    return { lease, action: 'failed', message: lease.lastError };
  }
}

export async function processGridProcessorTelemetry(
  chainId: number,
  telemetry: GridProcessorTelemetry & { deploymentHash?: string; codeHash?: string }
): Promise<GridOrchestratorResult> {
  const now = serverNow();
  let lease = recordGridProcessorTelemetry(await getGridProcessorLease(chainId), telemetry, now);

  if (!lease.pendingProcessorAddress || !lease.pendingDeploymentId) {
    lease = await saveGridProcessorLease(lease);
    return { lease, action: 'none' };
  }

  try {
    const authorization = await ensureProcessorAuthorized({
      chainId,
      processorAddress: lease.pendingProcessorAddress,
      deploymentHash: telemetry.deploymentHash,
      codeHash: telemetry.codeHash,
    });

    const oldProcessor = lease.currentProcessorAddress;
    const oldDeployment = lease.currentDeploymentId;
    lease = markGridProcessorAuthorized(
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
      const revocation = await revokeProcessor({ chainId, processorAddress: oldProcessor });
      lease = markGridProcessorRevoked(
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

    lease = await saveGridProcessorLease(lease);
    return { lease, action: 'processor_authorized' };
  } catch (error) {
    lease = await saveGridProcessorLease({
      ...lease,
      state: 'failed',
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: now.toISOString(),
    });
    return { lease, action: 'failed', message: lease.lastError };
  }
}
