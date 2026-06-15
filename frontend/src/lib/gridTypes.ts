export type HexAddress = `0x${string}`;

export type GridStrategyStatus =
  | 'Draft'
  | 'Funded'
  | 'Active'
  | 'Paused'
  | 'GasPaused'
  | 'Archived'
  | 'Closed';

export type ExecutionJobStatus =
  | 'pending'
  | 'claimed'
  | 'stale'
  | 'submitted'
  | 'confirmed'
  | 'reverted'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type ChainStateSnapshot = {
  strategyVersion: number;
  currentGridLevel: number;
  lastExecutionAt: string;
  quoteBalance: string;
  baseBalance: string;
};

export type ExecutionJob = {
  id: string;
  strategyId: string;
  pairId: string;
  side: 'buy' | 'sell';
  gridLevel: number;
  idempotencyKey: string;
  chainStateSnapshot: ChainStateSnapshot;
  status: ExecutionJobStatus;
  attempts: number;
  createdAt: string;
  claimedAt?: string;
  submittedAt?: string;
  confirmedAt?: string;
  txHash?: HexAddress;
  gasUsed?: string;
  gasCostQuote?: string;
  staleReason?: string;
  revertReason?: string;
  error?: string;
};

export type GridEncryptionIdentityStatus = 'active' | 'rotating' | 'retired';

export type GridEncryptionIdentity = {
  publicKey: string;
  keyId: string;
  attestationId: string;
  codeHash: string;
  deploymentHash: string;
  processorAddress: HexAddress;
  validFrom: string;
  validUntil?: string;
  status: GridEncryptionIdentityStatus;
};

export type GridAttestationEvidence = {
  identity: GridEncryptionIdentity;
  evidence: {
    processorAddress: HexAddress;
    codeHash: string;
    deploymentHash: string;
    publicKeyHash: string;
    issuedAt: string;
    expiresAt?: string;
  };
};

export type GridAttestationVerification = {
  verified: boolean;
  failures: string[];
};

export type GridGasSummary = {
  gasReserveQuote: string;
  gasSpentQuote: string;
  maxGasCostQuotePerTrade: string;
  minGasReserveQuote: string;
  testingGasSubsidyMode: boolean;
};
