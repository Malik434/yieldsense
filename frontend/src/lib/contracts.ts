import { base, baseSepolia } from 'wagmi/chains';

const MAINNET_KEEPER = '0x757d30F22692Bf81aE3E3feb0F8FB7cAD48F7CEF';
const MAINNET_AUTOCOMPOUNDER = '0x8654862B4FaB12aC09843cc1b644E6dA5aa6DC4A';
const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAINNET_AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
const MAINNET_POOL = '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d';
const MAINNET_GAUGE = '0x4F09bAb2f0E15e2A078A227FE1537665F55b8360';
const MAINNET_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const MAINNET_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

const TESTNET_KEEPER = process.env.NEXT_PUBLIC_TESTNET_KEEPER_ADDRESS || process.env.NEXT_PUBLIC_KEEPER_ADDRESS || '';
const TESTNET_ASSET = process.env.NEXT_PUBLIC_TESTNET_ASSET_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// Chain Configuration Mapping
export const CHAIN_CONFIG = {
  [base.id]: {
    name: 'Base Mainnet',
    shortName: 'Mainnet',
    explorer: 'https://basescan.org',
    keeper: (process.env.NEXT_PUBLIC_MAINNET_KEEPER_ADDRESS || MAINNET_KEEPER) as `0x${string}`,
    asset: (process.env.NEXT_PUBLIC_MAINNET_ASSET_ADDRESS || MAINNET_USDC) as `0x${string}`,
    autocompounder: (process.env.NEXT_PUBLIC_MAINNET_AUTOCOMPOUNDER_ADDRESS || MAINNET_AUTOCOMPOUNDER) as `0x${string}`,
    pool: MAINNET_POOL as `0x${string}`,
    gauge: MAINNET_GAUGE as `0x${string}`,
    rewardToken: MAINNET_AERO as `0x${string}`,
    router: MAINNET_ROUTER as `0x${string}`,
    factory: MAINNET_FACTORY as `0x${string}`,
    rpc: process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://mainnet.base.org',
    deploymentBlock: BigInt('45858549'),
    isProduction: true,
  },
  [baseSepolia.id]: {
    name: 'Base Testnet',
    shortName: 'Testnet',
    explorer: 'https://sepolia.basescan.org',
    keeper: TESTNET_KEEPER as `0x${string}`,
    asset: TESTNET_ASSET as `0x${string}`,
    autocompounder: (process.env.NEXT_PUBLIC_TESTNET_AUTOCOMPOUNDER_ADDRESS || '') as `0x${string}`,
    pool: (process.env.NEXT_PUBLIC_TESTNET_POOL_ADDRESS || '') as `0x${string}`,
    gauge: (process.env.NEXT_PUBLIC_TESTNET_GAUGE_ADDRESS || '') as `0x${string}`,
    rewardToken: (process.env.NEXT_PUBLIC_TESTNET_REWARD_TOKEN_ADDRESS || '') as `0x${string}`,
    router: (process.env.NEXT_PUBLIC_TESTNET_ROUTER_ADDRESS || '') as `0x${string}`,
    factory: (process.env.NEXT_PUBLIC_TESTNET_FACTORY_ADDRESS || '') as `0x${string}`,
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
export const ASSET_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).asset;
export const AUTOCOMPOUNDER_ADDRESS = getContractConfig(DEFAULT_CHAIN_ID).autocompounder;

/**
 * The operator wallet that owns all Acurast processor deployments.
 * Telemetry logs are always stored under this address, regardless of
 * which user's wallet is currently connected. This is correct for a
 * shared pooled vault — one processor serves all depositors.
 */
export const OPERATOR_ADDRESS = "0x1B77DAd014Cc99d877fE8CF5152773432d39d7bA";

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
    "outputs": [{ "internalType": "contract IERC20", "name": "", "type": "address" }],
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
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "balanceOf",
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
    "inputs": [
      { "internalType": "address", "name": "processor", "type": "address" }
    ],
    "name": "ownerAttestProcessor",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address[]", "name": "processors", "type": "address[]" }
    ],
    "name": "ownerAttestProcessors",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "", "type": "address" }
    ],
    "name": "attestedProcessors",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
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
      { "indexed": true,  "internalType": "address", "name": "processor",      "type": "address" },
      { "indexed": true,  "internalType": "uint256", "name": "nonce",           "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "profitCredited",  "type": "uint256" }
    ],
    "name": "HarvestExecuted",
    "type": "event"
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
      { "indexed": true, "internalType": "address", "name": "processor", "type": "address" }
    ],
    "name": "ProcessorAssigned",
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
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": false, "internalType": "uint256", "name": "rewardClaimed", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "rewardSwappedToAsset", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "lpAdded", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "profitUsdc", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "timestamp", "type": "uint256" }
    ],
    "name": "HarvestAndCompounded",
    "type": "event"
  }
] as const;

export const MOCK_USDC_ABI = [
  {
    "inputs": [
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
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
