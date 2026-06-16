type AssignmentStrategy = { type: "Single" | "Competing" };
type ExecutionConfig = {
  type: "interval";
  intervalInMs: number;
  numberOfExecutions: number;
  maxExecutionTimeInMs: number;
};
type AcurastDeploymentRef = ["Acurast", string, number];

const YIELD_PROCESSOR_INTERVAL_MS = 60 * 60_000;
const GRID_PROCESSOR_INTERVAL_MS = 60_000;

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
  mutability: "Immutable" | "Mutable";
  restartPolicy: "no" | "onFailure";
  reuseKeysFrom?: AcurastDeploymentRef;
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
    YieldSenseYieldExecutor: {
      projectName: "YieldSenseYieldExecutor",
      fileUrl: "dist/index.bundle.cjs",
      network: "mainnet",
      onlyAttestedDevices: true,
      assignmentStrategy: { type: "Single" },
      execution: {
        type: "interval",
        intervalInMs: YIELD_PROCESSOR_INTERVAL_MS,
        numberOfExecutions: 8_760,
        maxExecutionTimeInMs: 50_000,
      },
      maxAllowedStartDelayInMs: 30_000,
      usageLimit: {
        maxMemory: 256_000_000,
        maxNetworkRequests: 250,
        maxStorage: 5_000_000,
      },
      numberOfReplicas: 1,
      requiredModules: [],
      minProcessorReputation: 0,
      maxCostPerExecution: 100_000_000_000,
      includeEnvironmentVariables: [],
      processorWhitelist: [],
      mutability: "Mutable",
      restartPolicy: "onFailure",
    },
    YieldSenseGridExecutor: {
      projectName: "YieldSenseGridExecutor",
      fileUrl: "dist/processor.bundle.cjs",
      network: "mainnet",
      onlyAttestedDevices: true,
      assignmentStrategy: { type: "Single" },
      execution: {
        type: "interval",
        intervalInMs: GRID_PROCESSOR_INTERVAL_MS,
        numberOfExecutions: 4_320,
        maxExecutionTimeInMs: 50_000,
      },
      maxAllowedStartDelayInMs: 30_000,
      usageLimit: {
        maxMemory: 256_000_000,
        maxNetworkRequests: 250,
        maxStorage: 5_000_000,
      },
      numberOfReplicas: 1,
      requiredModules: [],
      minProcessorReputation: 0,
      maxCostPerExecution: 100_000_000_000,
      includeEnvironmentVariables: [],
      processorWhitelist: [],
      mutability: "Mutable",
      restartPolicy: "onFailure",
    },
  },
};

export default config;
