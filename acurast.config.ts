type AssignmentStrategy = { type: "Single" | "RoundRobin" };
type ExecutionConfig = { type: "interval"; intervalInMs: number; numberOfExecutions: number };

interface AcurastProjectConfig {
  projectName: string;
  fileUrl: string;
  network: "mainnet" | "testnet";
  onlyAttestedDevices: boolean;
  assignmentStrategy: AssignmentStrategy;
  execution: ExecutionConfig;
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
  includeEnvironmentVariables: string[];
  processorWhitelist: string[];
}

interface AcurastConfig {
  projects: Record<string, AcurastProjectConfig>;
}

/**
 * Deployment config for confidential grid/stop-loss monitoring in Acurast TEE.
 * Keep `STOP_LOSS_SECRET_JSON` encrypted at rest and only injected by Acurast env.
 */
const config: AcurastConfig = {
  projects: {
    YieldSenseGridKeeper: {
      projectName: "YieldSenseGridKeeper",
      fileUrl: "dist/processor.js",
      network: "mainnet",
      onlyAttestedDevices: true,
      assignmentStrategy: { type: "Single" },
      execution: {
        type: "interval",
        intervalInMs: 60_000,
        numberOfExecutions: 100_000,
      },
      maxAllowedStartDelayInMs: 30_000,
      usageLimit: {
        maxMemory: 256_000_000,
        maxNetworkRequests: 60,
        maxStorage: 5_000_000,
      },
      numberOfReplicas: 1,
      requiredModules: [],
      minProcessorReputation: 0,
      maxCostPerExecution: 100_000_000_000,
      includeEnvironmentVariables: [
        "RPC_URL",
        "UNISWAP_POOL_ADDRESS",
        "KEEPER_ADDRESS",
        "GRID_CONFIG_JSON",
        "STOP_LOSS_SECRET_JSON",
        "STOP_LOSS_SIGNED_PAYLOAD",
      ],
      // For strict signer pinning, whitelist your Pixel 8 processor account(s).
      processorWhitelist: [],
    },
  },
};

export default config;
