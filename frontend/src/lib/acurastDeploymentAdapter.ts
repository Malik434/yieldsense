import { createHash } from 'crypto';
import { PROCESSOR_BUNDLE } from './processorBundle';
import { YIELD_PROCESSOR_BUNDLE } from './yieldProcessorBundle';
import type { AcurastDeploymentRef } from './gridProcessorLease';

export type AcurastProcessorKind = 'grid' | 'yield';

export type AcurastDeploymentRequest = {
  chainId: number;
  leaseEpoch: number;
  intervalInMs: number;
  numberOfExecutions: number;
  mutability: 'Mutable';
  restartPolicy: 'onFailure';
  reuseKeysFrom?: AcurastDeploymentRef;
};

export type AcurastDeploymentResponse = {
  deploymentId: string;
  scriptUrl?: string;
  mode: 'local' | 'remote';
};

type AcurastDeploymentPayload = AcurastDeploymentRequest & {
  processorKind: AcurastProcessorKind;
  projectName: string;
  scriptUrl: string;
  scriptHash: string;
  network: 'mainnet' | 'testnet';
  assignmentStrategy: { type: 'Single' | 'Competing' };
  maxExecutionTimeInMs: number;
  maxAllowedStartDelayInMs: number;
  usageLimit: {
    maxMemory: number;
    maxNetworkRequests: number;
    maxStorage: number;
  };
  numberOfReplicas: number;
  requiredModules: string[];
  minProcessorReputation: number;
  maxCostPerExecution: number;
  processorWhitelist: string[];
};

const DEFAULT_MAX_EXECUTION_TIME_MS = 50_000;
const DEFAULT_MAX_ALLOWED_START_DELAY_MS = 60_000;

export function parseAcurastDeploymentRequest(body: unknown): AcurastDeploymentRequest {
  const payload = body as Partial<AcurastDeploymentRequest>;
  const chainId = Number(payload.chainId);
  const leaseEpoch = Number(payload.leaseEpoch);
  const intervalInMs = Number(payload.intervalInMs);
  const numberOfExecutions = Number(payload.numberOfExecutions);

  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid chainId');
  if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0) throw new Error('Invalid leaseEpoch');
  if (!Number.isSafeInteger(intervalInMs) || intervalInMs <= 0) throw new Error('Invalid intervalInMs');
  if (!Number.isSafeInteger(numberOfExecutions) || numberOfExecutions <= 0) {
    throw new Error('Invalid numberOfExecutions');
  }
  if (payload.mutability !== 'Mutable') throw new Error('mutability must be Mutable');
  if (payload.restartPolicy !== 'onFailure') throw new Error('restartPolicy must be onFailure');

  return {
    chainId,
    leaseEpoch,
    intervalInMs,
    numberOfExecutions,
    mutability: payload.mutability,
    restartPolicy: payload.restartPolicy,
    reuseKeysFrom: payload.reuseKeysFrom,
  };
}

function requireCleanUrl(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readOptionalEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function getDeploymentMode() {
  const mode = process.env.ACURAST_DEPLOYMENT_MODE?.trim().toLowerCase();
  if (mode === 'local' || mode === 'remote') return mode;
  return process.env.ACURAST_DEPLOYMENT_ADAPTER_URL?.trim() ? 'remote' : undefined;
}

function getProjectName(kind: AcurastProcessorKind) {
  return kind === 'grid'
    ? process.env.ACURAST_GRID_PROJECT_NAME?.trim() || 'YieldSenseGridExecutor'
    : process.env.ACURAST_YIELD_PROJECT_NAME?.trim() || 'YieldSenseYieldExecutor';
}

function getNetwork(chainId: number): 'mainnet' | 'testnet' {
  return chainId === 8453 ? 'mainnet' : 'testnet';
}

function getStaticScriptUrl(kind: AcurastProcessorKind) {
  return kind === 'grid'
    ? readOptionalEnv('ACURAST_GRID_SCRIPT_IPFS_URL', 'ACURAST_GRID_SCRIPT_URL')
    : readOptionalEnv('ACURAST_YIELD_SCRIPT_IPFS_URL', 'ACURAST_YIELD_SCRIPT_URL');
}

function getTelemetryUrl() {
  const frontendUrl = readOptionalEnv('FRONTEND_URL', 'NEXT_PUBLIC_APP_URL', 'URL');
  return process.env.TELEMETRY_URL?.trim() || (frontendUrl ? `${frontendUrl.replace(/\/$/, '')}/api/telemetry` : undefined);
}

function buildEnvInjection(kind: AcurastProcessorKind, request: AcurastDeploymentRequest) {
  const leaseEpochKey = kind === 'grid' ? 'GRID_PROCESSOR_LEASE_EPOCH' : 'YIELD_PROCESSOR_LEASE_EPOCH';
  const values: Record<string, string | undefined> = {
    CHAIN_ID: String(request.chainId),
    YIELD_CHAIN_ID: String(request.chainId),
    [leaseEpochKey]: String(request.leaseEpoch),
    TELEMETRY_URL: getTelemetryUrl(),
    FRONTEND_URL: readOptionalEnv('FRONTEND_URL', 'NEXT_PUBLIC_APP_URL', 'URL'),
    RPC_URL: readOptionalEnv('RPC_URL', 'MAINNET_RPC_URL', 'NEXT_PUBLIC_MAINNET_RPC_URL'),
    DATA_RPC_URL: readOptionalEnv('DATA_RPC_URL', 'MAINNET_RPC_URL', 'NEXT_PUBLIC_MAINNET_RPC_URL'),
    EXECUTOR_REGISTRY_ADDRESS: readOptionalEnv('EXECUTOR_REGISTRY_ADDRESS', 'NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS'),
    GRID_STRATEGY_MANAGER_ADDRESS: readOptionalEnv(
      'GRID_STRATEGY_MANAGER_ADDRESS',
      'NEXT_PUBLIC_GRID_STRATEGY_MANAGER_ADDRESS'
    ),
    GRID_EXECUTION_ROUTER_ADDRESS: readOptionalEnv(
      'GRID_EXECUTION_ROUTER_ADDRESS',
      'NEXT_PUBLIC_GRID_EXECUTION_ROUTER_ADDRESS'
    ),
    KEEPER_ADDRESS: readOptionalEnv('KEEPER_ADDRESS', 'NEXT_PUBLIC_MAINNET_KEEPER_ADDRESS'),
    POOL_ADDRESS: readOptionalEnv('POOL_ADDRESS', 'GRID_POOL_ADDRESS'),
    GAUGE_ADDRESS: readOptionalEnv('GAUGE_ADDRESS'),
    ENABLE_LIVE_GRID_EXECUTOR: kind === 'grid' ? 'true' : undefined,
  };

  const assignments = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `  e[${JSON.stringify(key)}]=${JSON.stringify(value)};`);

  return [
    '// YieldSense Acurast deployment env injection',
    ';(function(e){',
    ...assignments,
    '})(typeof process!=="undefined"?process.env:(globalThis.__ENV__=globalThis.__ENV__||{}));',
    '',
  ].join('\n');
}

function buildProcessorScript(kind: AcurastProcessorKind, request: AcurastDeploymentRequest) {
  const bundle = kind === 'grid' ? PROCESSOR_BUNDLE : YIELD_PROCESSOR_BUNDLE;
  return `${buildEnvInjection(kind, request)}${bundle}`;
}

function sha256Hex(value: string) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

async function uploadScriptToPinata(kind: AcurastProcessorKind, request: AcurastDeploymentRequest) {
  const staticUrl = getStaticScriptUrl(kind);
  if (staticUrl) {
    return {
      scriptUrl: staticUrl,
      scriptHash: sha256Hex(`${kind}:${staticUrl}`),
    };
  }

  const pinataJwt = process.env.PINATA_JWT?.trim();
  if (!pinataJwt) {
    throw new Error(
      `${kind === 'grid' ? 'ACURAST_GRID_SCRIPT_IPFS_URL' : 'ACURAST_YIELD_SCRIPT_IPFS_URL'} or PINATA_JWT is required`
    );
  }

  const script = buildProcessorScript(kind, request);
  const blob = new Blob([script], { type: 'application/javascript' });
  const formData = new FormData();
  formData.append('file', blob, `${getProjectName(kind)}-${request.chainId}-${request.leaseEpoch}.cjs`);
  formData.append(
    'pinataMetadata',
    JSON.stringify({
      name: `${getProjectName(kind)}-${request.chainId}-${request.leaseEpoch}`,
      keyvalues: {
        processorKind: kind,
        chainId: String(request.chainId),
        leaseEpoch: String(request.leaseEpoch),
      },
    })
  );

  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pinataJwt}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Pinata upload failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  if (!body?.IpfsHash || typeof body.IpfsHash !== 'string') {
    throw new Error('Pinata upload did not return IpfsHash');
  }

  return {
    scriptUrl: `ipfs://${body.IpfsHash}`,
    scriptHash: sha256Hex(script),
  };
}

async function buildDeploymentPayload(
  kind: AcurastProcessorKind,
  request: AcurastDeploymentRequest
): Promise<AcurastDeploymentPayload> {
  const { scriptUrl, scriptHash } = await uploadScriptToPinata(kind, request);

  return {
    ...request,
    processorKind: kind,
    projectName: getProjectName(kind),
    scriptUrl,
    scriptHash,
    network: getNetwork(request.chainId),
    assignmentStrategy: { type: 'Single' },
    maxExecutionTimeInMs: Number(process.env.ACURAST_MAX_EXECUTION_TIME_MS ?? DEFAULT_MAX_EXECUTION_TIME_MS),
    maxAllowedStartDelayInMs: Number(
      process.env.ACURAST_MAX_ALLOWED_START_DELAY_MS ?? DEFAULT_MAX_ALLOWED_START_DELAY_MS
    ),
    usageLimit: {
      maxMemory: Number(process.env.ACURAST_MAX_MEMORY ?? 256_000_000),
      maxNetworkRequests: Number(process.env.ACURAST_MAX_NETWORK_REQUESTS ?? 10_000),
      maxStorage: Number(process.env.ACURAST_MAX_STORAGE ?? 1_000_000),
    },
    numberOfReplicas: Number(process.env.ACURAST_NUMBER_OF_REPLICAS ?? 1),
    requiredModules: [],
    minProcessorReputation: Number(process.env.ACURAST_MIN_PROCESSOR_REPUTATION ?? 0),
    maxCostPerExecution: Number(process.env.ACURAST_MAX_COST_PER_EXECUTION ?? 5_500_000_000),
    processorWhitelist: [],
  };
}

function buildLocalDeploymentId(kind: AcurastProcessorKind, chainId: number, leaseEpoch: number) {
  return `Acurast:yieldsense-${kind}-${chainId}-local:${leaseEpoch}`;
}

export async function deployAcurastProcessor(
  kind: AcurastProcessorKind,
  request: AcurastDeploymentRequest
): Promise<AcurastDeploymentResponse | null> {
  const mode = getDeploymentMode();
  if (!mode) return null;

  if (mode === 'local') {
    const staticScriptUrl = getStaticScriptUrl(kind);
    if (!staticScriptUrl && !process.env.PINATA_JWT?.trim()) {
      return {
        deploymentId: buildLocalDeploymentId(kind, request.chainId, request.leaseEpoch),
        scriptUrl: `local://${getProjectName(kind)}/${request.chainId}/${request.leaseEpoch}`,
        mode: 'local',
      };
    }

    const payload = await buildDeploymentPayload(kind, request);
    return {
      deploymentId: buildLocalDeploymentId(kind, request.chainId, request.leaseEpoch),
      scriptUrl: payload.scriptUrl,
      mode: 'local',
    };
  }

  const payload = await buildDeploymentPayload(kind, request);

  const response = await fetch(requireCleanUrl('ACURAST_DEPLOYMENT_ADAPTER_URL'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.ACURAST_DEPLOYMENT_ADAPTER_SECRET?.trim()
        ? { Authorization: `Bearer ${process.env.ACURAST_DEPLOYMENT_ADAPTER_SECRET.trim()}` }
        : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Acurast deployment adapter failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  if (!body?.deploymentId || typeof body.deploymentId !== 'string') {
    throw new Error('Acurast deployment adapter did not return deploymentId');
  }

  return {
    deploymentId: body.deploymentId,
    scriptUrl: body.scriptUrl ?? payload.scriptUrl,
    mode: 'remote',
  };
}
