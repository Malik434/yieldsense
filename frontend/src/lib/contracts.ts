import { base, baseSepolia } from 'wagmi/chains';

const MAINNET_KEEPER = '0xEb7cac0570236D6A36DF7BcCF275Cb6681f84792';
const MAINNET_EXECUTOR_REGISTRY = process.env.NEXT_PUBLIC_MAINNET_EXECUTOR_REGISTRY_ADDRESS || process.env.NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS || '';
const MAINNET_AUTOCOMPOUNDER = '0xf1CD91df320b0291a3EF89B838e5Bf2c51e8b228';
const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAINNET_AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
const MAINNET_POOL = '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
const MAINNET_GAUGE = '0x4F09bAb2f0E15e2A078A227FE1537665F55b8360';
const MAINNET_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const MAINNET_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const MAINNET_GRID_VAULT = process.env.NEXT_PUBLIC_MAINNET_GRID_VAULT_ADDRESS || process.env.NEXT_PUBLIC_GRID_VAULT_ADDRESS || '';
const MAINNET_GRID_STRATEGY_MANAGER = process.env.NEXT_PUBLIC_MAINNET_GRID_STRATEGY_MANAGER_ADDRESS || process.env.NEXT_PUBLIC_GRID_STRATEGY_MANAGER_ADDRESS || '';
const MAINNET_GRID_EXECUTION_ROUTER = process.env.NEXT_PUBLIC_MAINNET_GRID_EXECUTION_ROUTER_ADDRESS || process.env.NEXT_PUBLIC_GRID_EXECUTION_ROUTER_ADDRESS || '';

const TESTNET_KEEPER = process.env.NEXT_PUBLIC_TESTNET_KEEPER_ADDRESS || process.env.NEXT_PUBLIC_KEEPER_ADDRESS || '';
const TESTNET_EXECUTOR_REGISTRY = process.env.NEXT_PUBLIC_TESTNET_EXECUTOR_REGISTRY_ADDRESS || process.env.NEXT_PUBLIC_EXECUTOR_REGISTRY_ADDRESS || '';
const TESTNET_ASSET = process.env.NEXT_PUBLIC_TESTNET_ASSET_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TESTNET_GRID_VAULT = process.env.NEXT_PUBLIC_TESTNET_GRID_VAULT_ADDRESS || process.env.NEXT_PUBLIC_GRID_VAULT_ADDRESS || '';
const TESTNET_GRID_STRATEGY_MANAGER = process.env.NEXT_PUBLIC_TESTNET_GRID_STRATEGY_MANAGER_ADDRESS || process.env.NEXT_PUBLIC_GRID_STRATEGY_MANAGER_ADDRESS || '';
const TESTNET_GRID_EXECUTION_ROUTER = process.env.NEXT_PUBLIC_TESTNET_GRID_EXECUTION_ROUTER_ADDRESS || process.env.NEXT_PUBLIC_GRID_EXECUTION_ROUTER_ADDRESS || '';

// Chain Configuration Mapping
export const CHAIN_CONFIG = {
  [base.id]: {
    name: 'Base Mainnet',
    shortName: 'Mainnet',
    explorer: 'https://basescan.org',
    keeper: (process.env.NEXT_PUBLIC_MAINNET_KEEPER_ADDRESS || MAINNET_KEEPER) as `0x${string}`,
    executorRegistry: MAINNET_EXECUTOR_REGISTRY as `0x${string}`,
    asset: (process.env.NEXT_PUBLIC_MAINNET_ASSET_ADDRESS || MAINNET_USDC) as `0x${string}`,
    autocompounder: (process.env.NEXT_PUBLIC_MAINNET_AUTOCOMPOUNDER_ADDRESS || MAINNET_AUTOCOMPOUNDER) as `0x${string}`,
    pool: MAINNET_POOL as `0x${string}`,
    gauge: MAINNET_GAUGE as `0x${string}`,
    rewardToken: MAINNET_AERO as `0x${string}`,
    router: MAINNET_ROUTER as `0x${string}`,
    factory: MAINNET_FACTORY as `0x${string}`,
    gridVault: MAINNET_GRID_VAULT as `0x${string}`,
    gridStrategyManager: MAINNET_GRID_STRATEGY_MANAGER as `0x${string}`,
    gridExecutionRouter: MAINNET_GRID_EXECUTION_ROUTER as `0x${string}`,
    rpc: process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://mainnet.base.org',
    deploymentBlock: BigInt('45858549'),
    isProduction: true,
  },
  [baseSepolia.id]: {
    name: 'Base Testnet',
    shortName: 'Testnet',
    explorer: 'https://sepolia.basescan.org',
    keeper: TESTNET_KEEPER as `0x${string}`,
    executorRegistry: TESTNET_EXECUTOR_REGISTRY as `0x${string}`,
    asset: TESTNET_ASSET as `0x${string}`,
    autocompounder: (process.env.NEXT_PUBLIC_TESTNET_AUTOCOMPOUNDER_ADDRESS || '') as `0x${string}`,
    pool: (process.env.NEXT_PUBLIC_TESTNET_POOL_ADDRESS || '') as `0x${string}`,
    gauge: (process.env.NEXT_PUBLIC_TESTNET_GAUGE_ADDRESS || '') as `0x${string}`,
    rewardToken: (process.env.NEXT_PUBLIC_TESTNET_REWARD_TOKEN_ADDRESS || '') as `0x${string}`,
    router: (process.env.NEXT_PUBLIC_TESTNET_ROUTER_ADDRESS || '') as `0x${string}`,
    factory: (process.env.NEXT_PUBLIC_TESTNET_FACTORY_ADDRESS || '') as `0x${string}`,
    gridVault: TESTNET_GRID_VAULT as `0x${string}`,
    gridStrategyManager: TESTNET_GRID_STRATEGY_MANAGER as `0x${string}`,
    gridExecutionRouter: TESTNET_GRID_EXECUTION_ROUTER as `0x${string}`,
    rpc: process.env.NEXT_PUBLIC_TESTNET_RPC_URL || 'https://sepolia.base.org',
    deploymentBlock: BigInt(process.env.NEXT_PUBLIC_TESTNET_DEPLOYMENT_BLOCK || '0'),
    isProduction: false,
  }
};

export const DEFAULT_CHAIN_ID = base.id;

export function getContractConfig(chainId: number | undefined) {
  return CHAIN_CONFIG[chainId as keyof typeof CHAIN_CONFIG] || CHAIN_CONFIG[DEFAULT_CHAIN_ID];
}

// Keep legacy exports as fallbacks but encourage using getContractConfig
export const KEEPER_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).keeper;
export const EXECUTOR_REGISTRY_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).executorRegistry;
export const ASSET_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).asset;
export const AUTOCOMPOUNDER_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).autocompounder;
export const GRID_VAULT_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).gridVault;
export const GRID_STRATEGY_MANAGER_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).gridStrategyManager;
export const GRID_EXECUTION_ROUTER_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).gridExecutionRouter;

export const OPERATOR_ADDRESS = "0x1B77DAd014Cc99d877fE8CF5152773432d39d7bA";

export const BUILDER_CODE_SUFFIX = "0x62635f6a3633763738616b0b0080218021802180218021802180218021" as const;

export const ERC20_ABI = [
  {
    "constant": true,
    "inputs": [
      { "name": "_owner", "type": "address" },
      { "name": "_spender", "type": "address" }
    ],
    "name": "allowance",
    "outputs": [{ "name": "", "type": "uint256" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": false,
    "inputs": [
      { "name": "_spender", "type": "address" },
      { "name": "_value", "type": "uint256" }
    ],
    "name": "approve",
    "outputs": [{ "name": "", "type": "bool" }],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [{ "name": "_owner", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "balance", "type": "uint256" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "name": "", "type": "uint8" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "symbol",
    "outputs": [{ "name": "", "type": "string" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  }
] as const;

export const KEEPER_ABI = [
  {
    "inputs": [],
    "name": "asset",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "executorRegistry",
    "outputs": [{ "internalType": "contract IExecutorRegistry", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "autocompounder",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "assets", "type": "uint256" },
      { "internalType": "address", "name": "receiver", "type": "address" }
    ],
    "name": "deposit",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "assets", "type": "uint256" },
      { "internalType": "address", "name": "receiver", "type": "address" },
      { "internalType": "address", "name": "owner", "type": "address" }
    ],
    "name": "withdraw",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "shares", "type": "uint256" },
      { "internalType": "address", "name": "receiver", "type": "address" },
      { "internalType": "address", "name": "owner", "type": "address" }
    ],
    "name": "redeem",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "maxDeposit",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "maxWithdraw",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "userProcessors",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "processor", "type": "address" }],
    "name": "assignProcessor",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "processor", "type": "address" }],
    "name": "ownerAttestProcessor",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address[]", "name": "processors", "type": "address[]" }],
    "name": "ownerAttestProcessors",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "name": "attestedProcessors",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "totalSupply",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "totalAssets",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "maxTotalAssets",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "user", "type": "address" },
      { "indexed": false, "internalType": "int256", "name": "pnlDelta", "type": "int256" },
      { "indexed": false, "internalType": "uint256", "name": "nonce", "type": "uint256" },
      { "indexed": true, "internalType": "bytes32", "name": "digest", "type": "bytes32" }
    ],
    "name": "TradeExecuted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "processor", "type": "address" },
      { "indexed": true, "internalType": "uint256", "name": "nonce", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "profitCredited", "type": "uint256" }
    ],
    "name": "HarvestExecuted",
    "type": "event"
  }
] as const;

export const EXECUTOR_REGISTRY_ABI = [
  {
    "inputs": [],
    "name": "YIELD_EXECUTOR",
    "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "GRID_EXECUTOR",
    "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "processor", "type": "address" },
      { "internalType": "bytes32", "name": "role", "type": "bytes32" }
    ],
    "name": "isAuthorized",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "processor", "type": "address" },
      { "indexed": true, "internalType": "bytes32", "name": "role", "type": "bytes32" },
      { "indexed": false, "internalType": "bytes32", "name": "deploymentHash", "type": "bytes32" },
      { "indexed": false, "internalType": "bytes32", "name": "codeHash", "type": "bytes32" }
    ],
    "name": "ProcessorRegistered",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "processor", "type": "address" },
      { "indexed": true, "internalType": "bytes32", "name": "role", "type": "bytes32" }
    ],
    "name": "ProcessorActivated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "processor", "type": "address" },
      { "indexed": true, "internalType": "bytes32", "name": "role", "type": "bytes32" }
    ],
    "name": "ProcessorRevoked",
    "type": "event"
  }
] as const;

export const AUTOCOMPOUNDER_ABI = [
  {
    "inputs": [],
    "name": "pendingProfit",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pendingRewards",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "stakedLpBalance",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "lastHarvestAt",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "totalCompounded",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

export const MOCK_USDC_ABI = [
  {
    "inputs": [{ "internalType": "uint256", "name": "amount", "type": "uint256" }],
    "name": "mint",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "internalType": "uint8", "name": "", "type": "uint8" }],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

export const GRID_VAULT_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "deposit",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "token", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "withdraw",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "", "type": "address" },
      { "internalType": "address", "name": "", "type": "address" }
    ],
    "name": "availableBalance",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "bytes32", "name": "", "type": "bytes32" },
      { "internalType": "address", "name": "", "type": "address" }
    ],
    "name": "lockedStrategyBalance",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pausedAll",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

export const GRID_STRATEGY_MANAGER_ABI = [
  {
    "inputs": [
      { "internalType": "bytes32", "name": "pairId", "type": "bytes32" },
      { "internalType": "bytes32", "name": "encryptedPayloadHash", "type": "bytes32" }
    ],
    "name": "createStrategy",
    "outputs": [{ "internalType": "bytes32", "name": "strategyId", "type": "bytes32" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "bytes32", "name": "strategyId", "type": "bytes32" },
      { "internalType": "uint256", "name": "tradingAmountQuote", "type": "uint256" },
      { "internalType": "uint256", "name": "gasReserveQuote", "type": "uint256" }
    ],
    "name": "allocateCapital",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "bytes32", "name": "strategyId", "type": "bytes32" }],
    "name": "enableStrategy",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "bytes32", "name": "strategyId", "type": "bytes32" }],
    "name": "pauseStrategy",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "bytes32", "name": "strategyId", "type": "bytes32" }],
    "name": "closeStrategy",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }],
    "name": "pairConfig",
    "outputs": [
      { "internalType": "address", "name": "baseToken", "type": "address" },
      { "internalType": "address", "name": "quoteToken", "type": "address" },
      { "internalType": "bool", "name": "enabled", "type": "bool" },
      { "internalType": "uint256", "name": "minGasReserveQuote", "type": "uint256" },
      { "internalType": "uint256", "name": "maxGasCostQuotePerTrade", "type": "uint256" },
      { "internalType": "uint64", "name": "minExecutionInterval", "type": "uint64" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "testingGasSubsidyMode",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "bytes32", "name": "strategyId", "type": "bytes32" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "addGasReserve",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "bytes32", "name": "strategyId", "type": "bytes32" }],
    "name": "getStrategy",
    "outputs": [
      {
        "components": [
          { "internalType": "bytes32", "name": "id", "type": "bytes32" },
          { "internalType": "address", "name": "owner", "type": "address" },
          { "internalType": "bytes32", "name": "pairId", "type": "bytes32" },
          { "internalType": "address", "name": "baseToken", "type": "address" },
          { "internalType": "address", "name": "quoteToken", "type": "address" },
          { "internalType": "uint256", "name": "allocatedQuote", "type": "uint256" },
          { "internalType": "uint256", "name": "quoteBalance", "type": "uint256" },
          { "internalType": "uint256", "name": "baseBalance", "type": "uint256" },
          { "internalType": "uint256", "name": "avgEntryPrice", "type": "uint256" },
          { "internalType": "int256", "name": "realizedPnlQuote", "type": "int256" },
          { "internalType": "uint256", "name": "feesPaidQuote", "type": "uint256" },
          { "internalType": "uint256", "name": "gasReserveQuote", "type": "uint256" },
          { "internalType": "uint256", "name": "gasSpentQuote", "type": "uint256" },
          { "internalType": "uint256", "name": "maxGasCostQuotePerTrade", "type": "uint256" },
          { "internalType": "uint64", "name": "lastExecutionAt", "type": "uint64" },
          { "internalType": "int32", "name": "currentGridLevel", "type": "int32" },
          { "internalType": "uint32", "name": "strategyVersion", "type": "uint32" },
          { "internalType": "bytes32", "name": "encryptedPayloadHash", "type": "bytes32" },
          { "internalType": "enum GridStrategyManager.StrategyStatus", "name": "status", "type": "uint8" },
          { "internalType": "uint64", "name": "createdAt", "type": "uint64" },
          { "internalType": "uint64", "name": "updatedAt", "type": "uint64" }
        ],
        "internalType": "struct GridStrategyManager.GridStrategy",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pausedAll",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "bytes32", "name": "strategyId", "type": "bytes32" },
      { "indexed": true, "internalType": "address", "name": "owner", "type": "address" },
      { "indexed": true, "internalType": "bytes32", "name": "pairId", "type": "bytes32" },
      { "indexed": false, "internalType": "bytes32", "name": "encryptedPayloadHash", "type": "bytes32" }
    ],
    "name": "StrategyCreated",
    "type": "event"
  }
] as const;
