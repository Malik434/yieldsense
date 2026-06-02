'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  Gauge,
  KeyRound,
  Loader2,
  Play,
  Plus,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { decodeEventLog, formatUnits, isAddress, keccak256, parseUnits, stringToBytes } from 'viem';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { useNetwork } from '@/providers/NetworkProvider';
import {
  ERC20_ABI,
  GRID_STRATEGY_MANAGER_ABI,
  GRID_VAULT_ABI,
} from '@/lib/contracts';
import { verifyGridAttestation } from '@/lib/gridAttestation';
import type {
  ExecutionJob,
  GridAttestationEvidence,
  GridAttestationVerification,
  HexAddress,
} from '@/lib/gridTypes';

type StrategyForm = {
  lowerPrice: string;
  upperPrice: string;
  gridCount: string;
  tradeSizeQuote: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  executionIntervalSec: string;
  maxSlippageBps: string;
};

type ProcessorRegistryResponse = {
  processors?: Array<{
    processor: HexAddress;
    role: string;
    active: boolean;
    codeHash?: string;
    deploymentHash?: string;
  }>;
};

const DEFAULT_FORM: StrategyForm = {
  lowerPrice: '0.80',
  upperPrice: '1.20',
  gridCount: '10',
  tradeSizeQuote: '2',
  stopLossPrice: '',
  takeProfitPrice: '',
  executionIntervalSec: '300',
  maxSlippageBps: '100',
};

const STATUS_LABELS = ['Draft', 'Funded', 'Active', 'Paused', 'GasPaused', 'Archived', 'Closed'];
const EXECUTION_INTERVALS = [
  { label: '1M', seconds: '60' },
  { label: '5M', seconds: '300' },
  { label: '15M', seconds: '900' },
  { label: '1H', seconds: '3600' },
];

function isConfigured(value: string | undefined): value is HexAddress {
  return Boolean(value && isAddress(value));
}

function short(value?: string) {
  if (!value) return 'Not set';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function createPayloadHash(form: StrategyForm, pairId: string, owner: string, chainId: number) {
  const normalized = JSON.stringify({
    owner: owner.toLowerCase(),
    chainId,
    pairId,
    lowerPrice: form.lowerPrice,
    upperPrice: form.upperPrice,
    gridCount: Number(form.gridCount),
    tradeSizeQuote: form.tradeSizeQuote,
    stopLossPrice: form.stopLossPrice || null,
    takeProfitPrice: form.takeProfitPrice || null,
    executionIntervalSec: Number(form.executionIntervalSec),
    maxSlippageBps: Number(form.maxSlippageBps),
  });
  return keccak256(stringToBytes(normalized));
}

export function GridTradingDashboard() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { config, chainId } = useNetwork();
  const { writeContractAsync } = useWriteContract();

  const [depositAmount, setDepositAmount] = useState('20');
  const [allocationAmount, setAllocationAmount] = useState('10');
  const [gasReserveAmount, setGasReserveAmount] = useState('2');
  const [form, setForm] = useState<StrategyForm>(DEFAULT_FORM);
  const [strategyId, setStrategyId] = useState<string>('');
  const [attestation, setAttestation] = useState<GridAttestationEvidence | null>(null);
  const [attestationStatus, setAttestationStatus] = useState<GridAttestationVerification | null>(null);
  const [queueJobs, setQueueJobs] = useState<ExecutionJob[]>([]);
  const [busyLabel, setBusyLabel] = useState('');
  const [error, setError] = useState('');

  const gridVault = config.gridVault;
  const strategyManager = config.gridStrategyManager;
  const quoteToken = config.asset;
  const baseToken = config.rewardToken;
  const pairId = useMemo(() => keccak256(stringToBytes('AERO-USDC')), []);
  const contractsReady = isConfigured(gridVault) && isConfigured(strategyManager) && isConfigured(quoteToken);

  const { data: quoteDecimalsRaw } = useReadContract({
    address: quoteToken,
    abi: ERC20_ABI,
    functionName: 'decimals',
    query: { enabled: isConfigured(quoteToken) },
  });

  const quoteDecimals = Number(quoteDecimalsRaw ?? 6);

  const { data: tokenBalanceRaw, refetch: refetchTokenBalance } = useReadContract({
    address: quoteToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && isConfigured(quoteToken)) },
  });

  const { data: allowanceRaw, refetch: refetchAllowance } = useReadContract({
    address: quoteToken,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address && isConfigured(gridVault) ? [address, gridVault] : undefined,
    query: { enabled: Boolean(address && isConfigured(quoteToken) && isConfigured(gridVault)) },
  });

  const { data: availableRaw, refetch: refetchAvailable } = useReadContract({
    address: gridVault,
    abi: GRID_VAULT_ABI,
    functionName: 'availableBalance',
    args: address && isConfigured(quoteToken) ? [address, quoteToken] : undefined,
    query: { enabled: Boolean(address && isConfigured(gridVault) && isConfigured(quoteToken)) },
  });

  const { data: strategyRaw, refetch: refetchStrategy } = useReadContract({
    address: strategyManager,
    abi: GRID_STRATEGY_MANAGER_ABI,
    functionName: 'getStrategy',
    args: strategyId ? [strategyId as `0x${string}`] : undefined,
    query: { enabled: Boolean(strategyId && isConfigured(strategyManager)) },
  });

  const strategy = strategyRaw as any;
  const currentStatus = strategy ? STATUS_LABELS[Number(strategy.status)] ?? 'Unknown' : 'No Strategy';
  const canEnable =
    contractsReady &&
    Boolean(strategyId) &&
    currentStatus !== 'Active' &&
    currentStatus !== 'GasPaused' &&
    Number(allocationAmount) > 0 &&
    (attestationStatus?.verified || !attestation);

  const refreshBalances = useCallback(async () => {
    await Promise.all([refetchTokenBalance(), refetchAllowance(), refetchAvailable(), refetchStrategy()]);
  }, [refetchAllowance, refetchAvailable, refetchStrategy, refetchTokenBalance]);

  const fetchAttestation = useCallback(async () => {
    if (!config.executorRegistry) return;
    try {
      const [identityRes, processorsRes] = await Promise.all([
        fetch('/api/grid/encryption-identity'),
        fetch(`/api/processors?chainId=${chainId}`),
      ]);

      if (!identityRes.ok) {
        setAttestation(null);
        setAttestationStatus(null);
        return;
      }

      const identity = (await identityRes.json()) as GridAttestationEvidence;
      const registry = processorsRes.ok ? ((await processorsRes.json()) as ProcessorRegistryResponse) : {};
      const gridProcessors = (registry.processors ?? []).filter((entry) => entry.role === 'GRID_EXECUTOR' && entry.active);

      const approvedMatch = gridProcessors.find(
        (entry) => entry.processor.toLowerCase() === identity.identity.processorAddress.toLowerCase(),
      );

      setAttestation(identity);
      setAttestationStatus(
        verifyGridAttestation({
          attestation: identity,
          authorizedGridExecutors: gridProcessors.map((entry) => entry.processor),
          approvedCodeHash: approvedMatch?.codeHash || process.env.NEXT_PUBLIC_GRID_PROCESSOR_CODE_HASH || identity.identity.codeHash,
          approvedDeploymentHash:
            approvedMatch?.deploymentHash || process.env.NEXT_PUBLIC_GRID_PROCESSOR_DEPLOYMENT_HASH || identity.identity.deploymentHash,
        }),
      );
    } catch (err) {
      setAttestationStatus({
        verified: false,
        failures: [err instanceof Error ? err.message : 'Failed to verify grid attestation'],
      });
    }
  }, [chainId, config.executorRegistry]);

  const fetchQueue = useCallback(async () => {
    if (!strategyId) {
      setQueueJobs([]);
      return;
    }
    const res = await fetch(`/api/grid/execution-queue?strategyId=${strategyId}`);
    if (res.ok) {
      const body = await res.json();
      setQueueJobs(body.jobs ?? []);
    }
  }, [strategyId]);

  useEffect(() => {
    const stored = address ? localStorage.getItem(`ys_grid_strategy_${address}_${chainId}`) : null;
    if (stored) setStrategyId(stored);
  }, [address, chainId]);

  useEffect(() => {
    fetchAttestation();
    const attestationInterval = setInterval(fetchAttestation, 60_000);
    return () => clearInterval(attestationInterval);
  }, [fetchAttestation]);

  useEffect(() => {
    fetchQueue();
    const queueInterval = setInterval(fetchQueue, 10_000);
    return () => clearInterval(queueInterval);
  }, [fetchQueue]);

  const runTx = async (label: string, action: () => Promise<unknown>) => {
    setBusyLabel(label);
    setError('');
    try {
      await action();
      await refreshBalances();
      await fetchQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyLabel('');
    }
  };

  const handleApprove = () =>
    runTx('Approving USDC', async () => {
      if (!contractsReady) throw new Error('Grid contracts are not configured.');
      const amount = parseUnits(depositAmount || '0', quoteDecimals);
      await writeContractAsync({
        address: quoteToken,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [gridVault, amount],
      });
    });

  const handleDeposit = () =>
    runTx('Depositing USDC', async () => {
      if (!contractsReady) throw new Error('Grid contracts are not configured.');
      const amount = parseUnits(depositAmount || '0', quoteDecimals);
      await writeContractAsync({
        address: gridVault,
        abi: GRID_VAULT_ABI,
        functionName: 'deposit',
        args: [quoteToken, amount],
      });
    });

  const handleCreateStrategy = () =>
    runTx('Creating strategy', async () => {
      if (!address || !publicClient || !contractsReady) throw new Error('Wallet or grid contracts are not ready.');
      if (attestation && !attestationStatus?.verified) throw new Error('Attestation must pass before sealing a confidential strategy.');

      const payloadHash = createPayloadHash(form, pairId, address, chainId);
      const txHash = await writeContractAsync({
        address: strategyManager,
        abi: GRID_STRATEGY_MANAGER_ABI,
        functionName: 'createStrategy',
        args: [pairId, payloadHash],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: GRID_STRATEGY_MANAGER_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'StrategyCreated') {
            const createdId = decoded.args.strategyId as string;
            setStrategyId(createdId);
            localStorage.setItem(`ys_grid_strategy_${address}_${chainId}`, createdId);
            return;
          }
        } catch {}
      }
      throw new Error('StrategyCreated event was not found in the transaction receipt.');
    });

  const handleAllocate = () =>
    runTx('Allocating capital', async () => {
      if (!strategyId || !contractsReady) throw new Error('Create a strategy before allocation.');
      await writeContractAsync({
        address: strategyManager,
        abi: GRID_STRATEGY_MANAGER_ABI,
        functionName: 'allocateCapital',
        args: [
          strategyId as `0x${string}`,
          parseUnits(allocationAmount || '0', quoteDecimals),
          parseUnits(gasReserveAmount || '0', quoteDecimals),
        ],
      });
    });

  const handleEnable = () =>
    runTx('Enabling grid trading', async () => {
      if (!strategyId || !contractsReady) throw new Error('Create and allocate a strategy first.');
      await writeContractAsync({
        address: strategyManager,
        abi: GRID_STRATEGY_MANAGER_ABI,
        functionName: 'enableStrategy',
        args: [strategyId as `0x${string}`],
      });
    });

  const handlePause = () =>
    runTx('Pausing grid trading', async () => {
      if (!strategyId || !contractsReady) throw new Error('No strategy selected.');
      await writeContractAsync({
        address: strategyManager,
        abi: GRID_STRATEGY_MANAGER_ABI,
        functionName: 'pauseStrategy',
        args: [strategyId as `0x${string}`],
      });
    });

  const allowance = Number(formatUnits((allowanceRaw as bigint | undefined) ?? BigInt(0), quoteDecimals));
  const depositValue = Number(depositAmount || 0);
  const needsApproval = allowance < depositValue;
  const tokenBalance = formatUnits((tokenBalanceRaw as bigint | undefined) ?? BigInt(0), quoteDecimals);
  const availableBalance = formatUnits((availableRaw as bigint | undefined) ?? BigInt(0), quoteDecimals);

  return (
    <div className="ys-card p-5 sm:p-8 flex flex-col gap-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="p-2.5 rounded-xl bg-[#C2E812]/10 border border-[#C2E812]/15">
            <Gauge size={22} className="text-[#C2E812]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Live Grid Engine</p>
            <h3 className="text-2xl font-heading font-bold text-[#F5F7FA]">AERO/USDC Grid Trading</h3>
            <p className="mt-2 max-w-2xl text-xs font-mono leading-relaxed text-[#8B949E] uppercase tracking-[0.16em]">
              Deposit grid capital, seal strategy parameters, allocate gas reserve, and enable the shared Acurast executor.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-[10px] font-mono font-bold uppercase tracking-widest sm:grid-cols-4 lg:min-w-[520px]">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[#484F58]">Wallet USDC</p>
            <p className="mt-2 text-[#F5F7FA]">{Number(tokenBalance).toFixed(2)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[#484F58]">Grid Free</p>
            <p className="mt-2 text-[#F5F7FA]">{Number(availableBalance).toFixed(2)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[#484F58]">Status</p>
            <p className="mt-2 text-[#F5F7FA]">{currentStatus}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[#484F58]">Strategy</p>
            <p className="mt-2 text-[#F5F7FA]">{short(strategyId)}</p>
          </div>
        </div>
      </div>

      {!isConnected ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-xs font-mono font-bold uppercase tracking-widest text-[#8B949E]">
          Connect a wallet to configure grid trading.
        </div>
      ) : !contractsReady ? (
        <div className="flex items-start gap-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-6">
          <AlertTriangle size={18} className="mt-0.5 text-amber-300" />
          <div>
            <p className="text-sm font-heading font-bold text-amber-100">Grid contracts are not configured</p>
            <p className="mt-2 text-xs font-mono leading-relaxed text-amber-100/70 uppercase tracking-[0.16em]">
              Set NEXT_PUBLIC_GRID_VAULT_ADDRESS and NEXT_PUBLIC_GRID_STRATEGY_MANAGER_ADDRESS after deployment.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-5 flex items-center gap-3">
            <Wallet size={17} className="text-[#C2E812]" />
            <h4 className="font-heading text-base font-bold text-[#F5F7FA]">Capital</h4>
          </div>
          <label className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Deposit USDC</label>
          <input
            value={depositAmount}
            onChange={(event) => setDepositAmount(event.target.value)}
            className="ys-input mt-3 w-full"
            type="number"
            min="0"
          />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button className="ys-btn-secondary h-12" disabled={!contractsReady || Boolean(busyLabel) || !needsApproval} onClick={handleApprove}>
              {needsApproval ? 'Approve' : 'Approved'}
            </button>
            <button className="ys-btn-primary h-12" disabled={!contractsReady || Boolean(busyLabel) || needsApproval} onClick={handleDeposit}>
              Deposit
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-5 flex items-center gap-3">
            <ShieldCheck size={17} className={attestationStatus?.verified ? 'text-[#00FFA3]' : 'text-amber-300'} />
            <h4 className="font-heading text-base font-bold text-[#F5F7FA]">Attestation</h4>
          </div>
          <div className="space-y-3 text-[10px] font-mono font-bold uppercase tracking-widest">
            <p className={attestationStatus?.verified ? 'text-[#00FFA3]' : 'text-amber-300'}>
              {attestationStatus?.verified ? 'TEE key verified' : 'Verification pending'}
            </p>
            <p className="text-[#484F58]">Processor: <span className="text-[#8B949E]">{short(attestation?.identity.processorAddress)}</span></p>
            <p className="text-[#484F58]">Key: <span className="text-[#8B949E]">{short(attestation?.identity.keyId)}</span></p>
          </div>
          {attestationStatus && !attestationStatus.verified && (
            <p className="mt-4 text-[10px] font-mono leading-relaxed text-[#FF4466] uppercase tracking-widest">
              {attestationStatus.failures[0] || 'Attestation failed'}
            </p>
          )}
          <button className="ys-btn-secondary mt-5 h-12 w-full" onClick={fetchAttestation}>
            <KeyRound size={15} /> Verify Key
          </button>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-5 flex items-center gap-3">
            <Activity size={17} className="text-[#00FFA3]" />
            <h4 className="font-heading text-base font-bold text-[#F5F7FA]">Accounting</h4>
          </div>
          <div className="grid grid-cols-2 gap-3 text-[10px] font-mono font-bold uppercase tracking-widest">
            <div>
              <p className="text-[#484F58]">Quote</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? Number(formatUnits(strategy.quoteBalance, quoteDecimals)).toFixed(2) : '0.00'}</p>
            </div>
            <div>
              <p className="text-[#484F58]">Base</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? Number(formatUnits(strategy.baseBalance, 18)).toFixed(4) : '0.0000'}</p>
            </div>
            <div>
              <p className="text-[#484F58]">Gas Reserve</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? Number(formatUnits(strategy.gasReserveQuote, quoteDecimals)).toFixed(2) : '0.00'}</p>
            </div>
            <div>
              <p className="text-[#484F58]">Gas Spent</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? Number(formatUnits(strategy.gasSpentQuote, quoteDecimals)).toFixed(2) : '0.00'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <h4 className="mb-5 font-heading text-base font-bold text-[#F5F7FA]">Strategy Parameters</h4>
          <div className="grid grid-cols-2 gap-4">
            {([
              ['lowerPrice', 'Lower'],
              ['upperPrice', 'Upper'],
              ['gridCount', 'Grids'],
              ['tradeSizeQuote', 'Trade USDC'],
              ['stopLossPrice', 'Stop Loss'],
              ['takeProfitPrice', 'Take Profit'],
              ['executionIntervalSec', 'Interval Sec'],
              ['maxSlippageBps', 'Slippage Bps'],
            ] as Array<[keyof StrategyForm, string]>).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-2">
                <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">{label}</span>
                <input
                  value={form[key]}
                  onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
                  className="ys-input w-full"
                  type="number"
                />
              </label>
            ))}
          </div>
          <div className="mt-5">
            <p className="mb-3 text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Execution Interval</p>
            <div className="grid grid-cols-4 gap-2">
              {EXECUTION_INTERVALS.map((interval) => (
                <button
                  key={interval.seconds}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, executionIntervalSec: interval.seconds }))}
                  className={`h-10 rounded-xl text-[10px] font-mono font-bold uppercase tracking-widest transition-all ${
                    form.executionIntervalSec === interval.seconds
                      ? 'bg-[#C2E812] text-[#030605]'
                      : 'border border-white/10 bg-white/5 text-[#8B949E] hover:text-[#F5F7FA]'
                  }`}
                >
                  {interval.label}
                </button>
              ))}
            </div>
          </div>
          <button className="ys-btn-primary mt-5 h-12 w-full" disabled={!contractsReady || Boolean(busyLabel)} onClick={handleCreateStrategy}>
            <Plus size={16} /> Seal & Create Strategy
          </button>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <h4 className="mb-5 font-heading text-base font-bold text-[#F5F7FA]">Allocation & Lifecycle</h4>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Trading Capital</span>
              <input value={allocationAmount} onChange={(event) => setAllocationAmount(event.target.value)} className="ys-input w-full" type="number" />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Gas Reserve</span>
              <input value={gasReserveAmount} onChange={(event) => setGasReserveAmount(event.target.value)} className="ys-input w-full" type="number" />
            </label>
          </div>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <button className="ys-btn-secondary h-12" disabled={!strategyId || Boolean(busyLabel)} onClick={handleAllocate}>
              Allocate
            </button>
            <button className="ys-btn-primary h-12" disabled={!canEnable || Boolean(busyLabel)} onClick={handleEnable}>
              <Play size={15} /> Enable
            </button>
            <button className="ys-btn-secondary h-12" disabled={!strategyId || currentStatus !== 'Active' || Boolean(busyLabel)} onClick={handlePause}>
              <CirclePause size={15} /> Pause
            </button>
          </div>

          <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#484F58]">Execution Queue</p>
              <button className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#C2E812]" onClick={fetchQueue}>
                Refresh
              </button>
            </div>
            <div className="space-y-2">
              {queueJobs.length === 0 ? (
                <p className="text-xs font-mono text-[#484F58]">No execution jobs for this strategy yet.</p>
              ) : (
                queueJobs.slice(0, 5).map((job) => (
                  <div key={job.id} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-[10px] font-mono uppercase tracking-widest">
                    <span className="text-[#8B949E]">{job.side} L{job.gridLevel}</span>
                    <span className={job.status === 'confirmed' ? 'text-[#00FFA3]' : job.status === 'reverted' || job.status === 'stale' ? 'text-[#FF4466]' : 'text-[#C2E812]'}>
                      {job.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {busyLabel && (
        <div className="flex items-center gap-3 rounded-xl border border-[#C2E812]/10 bg-[#C2E812]/[0.04] p-4 text-xs font-mono font-bold uppercase tracking-widest text-[#C2E812]">
          <Loader2 size={16} className="animate-spin" /> {busyLabel}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-[#FF4466]/15 bg-[#FF4466]/[0.04] p-4 text-xs font-mono leading-relaxed text-[#FF4466]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {attestationStatus?.verified && (
        <div className="flex items-center gap-3 rounded-xl border border-[#00FFA3]/10 bg-[#00FFA3]/[0.03] p-4 text-xs font-mono font-bold uppercase tracking-widest text-[#00FFA3]">
          <CheckCircle2 size={16} /> Strategy encryption key is bound to an authorized grid executor.
        </div>
      )}
    </div>
  );
}
