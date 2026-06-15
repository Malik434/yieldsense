import { createPublicClient, http, keccak256, parseAbiItem, stringToBytes, type Address } from 'viem';
import { getContractConfig } from '@/lib/contracts';
import { getLogsPaginated, withCache } from '@/lib/rpcUtils';

const PROCESSOR_REGISTERED_EVENT = parseAbiItem(
  'event ProcessorRegistered(address indexed processor, bytes32 indexed role, bytes32 deploymentHash, bytes32 codeHash)'
);
const PROCESSOR_REVOKED_EVENT = parseAbiItem(
  'event ProcessorRevoked(address indexed processor, bytes32 indexed role)'
);

export type ProcessorRegistryEntry = {
  processor: Address;
  role: string;
  roleHash: string;
  active: boolean;
  deploymentHash?: string;
  codeHash?: string;
  registeredBlock?: string;
  revokedBlock?: string;
};

export type ProcessorRegistryState = {
  chainId: number;
  executorRegistry: Address;
  processors: ProcessorRegistryEntry[];
};

function isAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function roleName(roleHash: string): string {
  const roles: Record<string, string> = {
    [keccak256(stringToBytes('YIELD_EXECUTOR'))]: 'YIELD_EXECUTOR',
    [keccak256(stringToBytes('GRID_EXECUTOR'))]: 'GRID_EXECUTOR',
    [keccak256(stringToBytes('MONITOR'))]: 'MONITOR',
    [keccak256(stringToBytes('EMERGENCY_OPERATOR'))]: 'EMERGENCY_OPERATOR',
  };
  return roles[roleHash] ?? roleHash;
}

export async function loadProcessorRegistry(chainId: number): Promise<ProcessorRegistryState | null> {
  return withCache(`processor-registry:${chainId}`, () => _fetchProcessorRegistry(chainId), 60_000);
}

async function _fetchProcessorRegistry(chainId: number): Promise<ProcessorRegistryState | null> {
  const config = getContractConfig(chainId);
  if (!isAddress(config.executorRegistry) || !config.rpc) return null;

  const client = createPublicClient({ transport: http(config.rpc) });
  const fromBlock = config.deploymentBlock ?? BigInt(0);
  const [registeredLogs, revokedLogs] = (await Promise.all([
    getLogsPaginated(client as any, { address: config.executorRegistry, event: PROCESSOR_REGISTERED_EVENT, fromBlock }),
    getLogsPaginated(client as any, { address: config.executorRegistry, event: PROCESSOR_REVOKED_EVENT, fromBlock }),
  ])) as [any[], any[]];

  const entries = new Map<string, ProcessorRegistryEntry>();

  const lifecycleLogs = [
    ...registeredLogs.map((log) => ({ ...log, kind: 'registered' as const })),
    ...revokedLogs.map((log) => ({ ...log, kind: 'revoked' as const })),
  ].sort((a, b) =>
    Number((a.blockNumber ?? BigInt(0)) - (b.blockNumber ?? BigInt(0))) ||
    Number((a.logIndex ?? 0) - (b.logIndex ?? 0))
  );

  for (const log of lifecycleLogs) {
    const processor = log.args?.processor as Address | undefined;
    const role = String(log.args?.role ?? '');
    if (!processor || !role) continue;
    const key = `${processor.toLowerCase()}:${role}`;

    if (log.kind === 'registered') {
      entries.set(key, {
        processor,
        role: roleName(role),
        roleHash: role,
        active: true,
        deploymentHash: log.args?.deploymentHash,
        codeHash: log.args?.codeHash,
        registeredBlock: String(log.blockNumber ?? 0),
      });
    } else {
      const existing = entries.get(key);
      if (existing) {
        entries.set(key, { ...existing, active: false, revokedBlock: String(log.blockNumber ?? 0) });
      } else {
        entries.set(key, {
          processor,
          role: roleName(role),
          roleHash: role,
          active: false,
          revokedBlock: String(log.blockNumber ?? 0),
        });
      }
    }
  }

  return {
    chainId,
    executorRegistry: config.executorRegistry,
    processors: Array.from(entries.values()).sort((a, b) => Number(b.active) - Number(a.active)),
  };
}
