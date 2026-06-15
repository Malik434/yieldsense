import { isAddress } from 'viem';
import { parseAcurastDeploymentRef, type AcurastDeploymentRef, type ProcessorRotation } from './gridProcessorLease';

export type YieldProcessorLeaseStateName =
  | 'disabled'
  | 'inactive'
  | 'deploying'
  | 'active'
  | 'updating'
  | 'handoff'
  | 'failed';

export type YieldProcessorLease = {
  version: number;
  chainId: number;
  enabled: boolean;
  state: YieldProcessorLeaseStateName;
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

export type YieldProcessorTelemetry = {
  deploymentId?: string;
  processorAddress?: string;
  leaseEpoch?: number;
  healthy?: boolean;
  timestamp?: number;
};

export const YIELD_LEASE_EXECUTION_INTERVAL_MS = 60 * 60_000;
export const YIELD_LEASE_NUMBER_OF_EXECUTIONS = 8_760;
export const YIELD_LEASE_DURATION_MS = YIELD_LEASE_EXECUTION_INTERVAL_MS * YIELD_LEASE_NUMBER_OF_EXECUTIONS;
export const YIELD_LEASE_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60_000;

export function emptyYieldProcessorLease(chainId: number, now = new Date()): YieldProcessorLease {
  return {
    version: 0,
    chainId,
    enabled: false,
    state: 'disabled',
    leaseEpoch: 0,
    rotations: [],
    updatedAt: now.toISOString(),
  };
}

function calculateLeaseExpiry(startedAt: Date) {
  return new Date(startedAt.getTime() + YIELD_LEASE_DURATION_MS);
}

function shouldRenewYieldLease(lease: YieldProcessorLease, now = new Date()) {
  if (lease.state !== 'active' || !lease.leaseExpiresAt) return false;
  return new Date(lease.leaseExpiresAt).getTime() - now.getTime() <= YIELD_LEASE_RENEWAL_WINDOW_MS;
}

export function setYieldLeaseEnabled(
  lease: YieldProcessorLease,
  enabled: boolean,
  now = new Date()
): YieldProcessorLease {
  if (!enabled) {
    return {
      ...lease,
      enabled: false,
      state: 'disabled',
      updatedAt: now.toISOString(),
    };
  }

  return {
    ...lease,
    enabled: true,
    state: lease.state === 'disabled' ? 'inactive' : lease.state,
    updatedAt: now.toISOString(),
  };
}

export function markYieldLeaseForDeployment(lease: YieldProcessorLease, now = new Date()): YieldProcessorLease {
  if (!lease.enabled) {
    return { ...lease, state: 'disabled', updatedAt: now.toISOString() };
  }

  if (lease.state === 'inactive' || lease.state === 'failed') {
    return {
      ...lease,
      state: 'deploying',
      leaseEpoch: lease.leaseEpoch + 1,
      reuseKeysFrom: parseAcurastDeploymentRef(lease.previousDeploymentId ?? lease.currentDeploymentId),
      updatedAt: now.toISOString(),
    };
  }

  return {
    ...lease,
    state: shouldRenewYieldLease(lease, now) ? 'updating' : lease.state,
    updatedAt: now.toISOString(),
  };
}

export function recordYieldDeploymentStarted(
  lease: YieldProcessorLease,
  deploymentId: string,
  now = new Date()
): YieldProcessorLease {
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

export function recordYieldProcessorTelemetry(
  lease: YieldProcessorLease,
  telemetry: YieldProcessorTelemetry,
  now = new Date()
): YieldProcessorLease {
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
    return { ...lease, lastTelemetryAt: telemetryAt, updatedAt: now.toISOString() };
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

export function markYieldProcessorAuthorized(
  lease: YieldProcessorLease,
  args: { deploymentId: string; processorAddress: string; txHash?: string; reason: string },
  now = new Date()
): YieldProcessorLease {
  return {
    ...lease,
    state: 'active',
    previousProcessorAddress: lease.currentProcessorAddress,
    previousDeploymentId: lease.currentDeploymentId ?? lease.previousDeploymentId,
    currentDeploymentId: args.deploymentId,
    currentProcessorAddress: args.processorAddress,
    pendingDeploymentId: undefined,
    pendingProcessorAddress: undefined,
    rotations: [
      ...lease.rotations,
      {
        deploymentId: args.deploymentId,
        processorAddress: args.processorAddress,
        action: 'register',
        txHash: args.txHash,
        reason: args.reason,
        createdAt: now.toISOString(),
      },
    ],
    lastHealthyAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function markYieldProcessorRevoked(
  lease: YieldProcessorLease,
  args: { deploymentId: string; processorAddress: string; txHash?: string; reason: string },
  now = new Date()
): YieldProcessorLease {
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
