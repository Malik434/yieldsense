import { isAddress } from 'viem';

export type GridProcessorLeaseStateName =
  | 'inactive'
  | 'deploying'
  | 'active'
  | 'updating'
  | 'handoff'
  | 'draining'
  | 'failed';

export type AcurastDeploymentRef = ['Acurast', string, number];

export type ProcessorRotation = {
  deploymentId: string;
  processorAddress: string;
  action: 'register' | 'revoke';
  txHash?: string;
  reason: string;
  createdAt: string;
};

export type GridProcessorLease = {
  version: number;
  chainId: number;
  state: GridProcessorLeaseStateName;
  activeStrategyIds: string[];
  currentDeploymentId?: string;
  previousDeploymentId?: string;
  currentProcessorAddress?: string;
  previousProcessorAddress?: string;
  reuseKeysFrom?: AcurastDeploymentRef;
  leaseEpoch: number;
  leaseStartedAt?: string;
  leaseExpiresAt?: string;
  lastTelemetryAt?: string;
  lastHealthyAt?: string;
  pendingProcessorAddress?: string;
  pendingDeploymentId?: string;
  lastError?: string;
  rotations: ProcessorRotation[];
  updatedAt: string;
};

export type GridProcessorTelemetry = {
  deploymentId?: string;
  processorAddress?: string;
  leaseEpoch?: number;
  healthy?: boolean;
  timestamp?: number;
};

export const GRID_LEASE_EXECUTION_INTERVAL_MS = 60_000;
export const GRID_LEASE_NUMBER_OF_EXECUTIONS = 4_320;
export const GRID_LEASE_DURATION_MS = GRID_LEASE_EXECUTION_INTERVAL_MS * GRID_LEASE_NUMBER_OF_EXECUTIONS;
export const GRID_LEASE_RENEWAL_WINDOW_MS = 12 * 60 * 60_000;

export function emptyGridProcessorLease(chainId: number, now = new Date()): GridProcessorLease {
  return {
    version: 0,
    chainId,
    state: 'inactive',
    activeStrategyIds: [],
    leaseEpoch: 0,
    rotations: [],
    updatedAt: now.toISOString(),
  };
}

export function parseAcurastDeploymentRef(deploymentId?: string): AcurastDeploymentRef | undefined {
  const parts = deploymentId?.split(':') ?? [];
  if (parts.length !== 3 || parts[0] !== 'Acurast') return undefined;
  const deploymentNumber = Number(parts[2]);
  if (!parts[1] || !Number.isSafeInteger(deploymentNumber)) return undefined;
  return ['Acurast', parts[1], deploymentNumber];
}

export function calculateLeaseExpiry(startedAt: Date) {
  return new Date(startedAt.getTime() + GRID_LEASE_DURATION_MS);
}

export function shouldStartGridLease(lease: GridProcessorLease, activeStrategyIds: string[]) {
  return activeStrategyIds.length > 0 && ['inactive', 'failed'].includes(lease.state);
}

export function shouldDrainGridLease(activeStrategyIds: string[]) {
  return activeStrategyIds.length === 0;
}

export function shouldRenewGridLease(lease: GridProcessorLease, now = new Date()) {
  if (lease.state !== 'active' || !lease.leaseExpiresAt) return false;
  return new Date(lease.leaseExpiresAt).getTime() - now.getTime() <= GRID_LEASE_RENEWAL_WINDOW_MS;
}

export function markGridLeaseCandidates(
  lease: GridProcessorLease,
  activeStrategyIds: string[],
  now = new Date()
): GridProcessorLease {
  if (shouldDrainGridLease(activeStrategyIds)) {
    return {
      ...lease,
      activeStrategyIds,
      state: lease.state === 'inactive' ? 'inactive' : 'draining',
      updatedAt: now.toISOString(),
    };
  }

  if (shouldStartGridLease(lease, activeStrategyIds)) {
    return {
      ...lease,
      activeStrategyIds,
      state: 'deploying',
      leaseEpoch: lease.leaseEpoch + 1,
      reuseKeysFrom: parseAcurastDeploymentRef(lease.previousDeploymentId ?? lease.currentDeploymentId),
      updatedAt: now.toISOString(),
    };
  }

  return {
    ...lease,
    activeStrategyIds,
    state: shouldRenewGridLease(lease, now) ? 'updating' : lease.state,
    updatedAt: now.toISOString(),
  };
}

export function recordGridDeploymentStarted(
  lease: GridProcessorLease,
  deploymentId: string,
  now = new Date()
): GridProcessorLease {
  return {
    ...lease,
    pendingDeploymentId: deploymentId,
    previousDeploymentId: lease.currentDeploymentId ?? lease.previousDeploymentId,
    state: lease.currentDeploymentId ? 'handoff' : 'deploying',
    leaseStartedAt: now.toISOString(),
    leaseExpiresAt: calculateLeaseExpiry(now).toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function recordGridProcessorTelemetry(
  lease: GridProcessorLease,
  telemetry: GridProcessorTelemetry,
  now = new Date()
): GridProcessorLease {
  const processorAddress = telemetry.processorAddress;
  const deploymentId = telemetry.deploymentId ?? lease.pendingDeploymentId ?? lease.currentDeploymentId;
  const telemetryAt = telemetry.timestamp ? new Date(telemetry.timestamp * 1000).toISOString() : now.toISOString();

  if (!processorAddress || !isAddress(processorAddress)) {
    return {
      ...lease,
      lastTelemetryAt: telemetryAt,
      lastError: 'Processor telemetry did not include a valid EVM address.',
      updatedAt: now.toISOString(),
    };
  }

  if (telemetry.leaseEpoch !== undefined && telemetry.leaseEpoch < lease.leaseEpoch) {
    return {
      ...lease,
      lastTelemetryAt: telemetryAt,
      updatedAt: now.toISOString(),
    };
  }

  return {
    ...lease,
    pendingProcessorAddress: processorAddress,
    pendingDeploymentId: deploymentId,
    lastTelemetryAt: telemetryAt,
    lastHealthyAt: telemetry.healthy === false ? lease.lastHealthyAt : telemetryAt,
    updatedAt: now.toISOString(),
  };
}

export function markGridProcessorAuthorized(
  lease: GridProcessorLease,
  args: { deploymentId: string; processorAddress: string; txHash?: string; reason: string },
  now = new Date()
): GridProcessorLease {
  const rotations = [
    ...lease.rotations,
    {
      deploymentId: args.deploymentId,
      processorAddress: args.processorAddress,
      action: 'register' as const,
      txHash: args.txHash,
      reason: args.reason,
      createdAt: now.toISOString(),
    },
  ];

  return {
    ...lease,
    state: 'active',
    previousProcessorAddress: lease.currentProcessorAddress,
    previousDeploymentId: lease.currentDeploymentId ?? lease.previousDeploymentId,
    currentDeploymentId: args.deploymentId,
    currentProcessorAddress: args.processorAddress,
    pendingDeploymentId: undefined,
    pendingProcessorAddress: undefined,
    rotations,
    lastHealthyAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function markGridProcessorRevoked(
  lease: GridProcessorLease,
  args: { deploymentId: string; processorAddress: string; txHash?: string; reason: string },
  now = new Date()
): GridProcessorLease {
  return {
    ...lease,
    rotations: [
      ...lease.rotations,
      {
        deploymentId: args.deploymentId,
        processorAddress: args.processorAddress,
        action: 'revoke',
        txHash: args.txHash,
        reason: args.reason,
        createdAt: now.toISOString(),
      },
    ],
    previousProcessorAddress:
      lease.previousProcessorAddress?.toLowerCase() === args.processorAddress.toLowerCase()
        ? undefined
        : lease.previousProcessorAddress,
    updatedAt: now.toISOString(),
  };
}
