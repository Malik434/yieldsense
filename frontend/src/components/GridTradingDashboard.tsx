'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  BookOpen,
  Check,
  ChevronDown,
  CirclePause,
  CircleX,
  Gauge,
  Loader2,
  Play,
  Plus,
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
import type { ExecutionJob, HexAddress } from '@/lib/gridTypes';
import type { GridPairConfig } from '@/lib/gridStore';

type StrategyForm = {
  lowerPrice: string;
  upperPrice: string;
  gridMode: 'arithmetic' | 'geometric';
  gridCount: string;
  tradeSizeQuote: string;
  triggerPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  executionIntervalSec: string;
  maxSlippageBps: string;
};

const DEFAULT_FORM: StrategyForm = {
  lowerPrice: '0.80',
  upperPrice: '1.20',
  gridMode: 'arithmetic',
  gridCount: '10',
  tradeSizeQuote: '2',
  triggerPrice: '',
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
const DEFAULT_IMPORTED_STRATEGY_ID =
  process.env.NEXT_PUBLIC_GRID_STRATEGY_ID ||
  process.env.NEXT_PUBLIC_SMOKE_GRID_STRATEGY_ID ||
  '';

function isConfigured(value: string | undefined): value is HexAddress {
  return Boolean(value && isAddress(value));
}

function short(value?: string) {
  if (!value) return 'Not set';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isStrategyId(value: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function createPayloadHash(form: StrategyForm, pairId: string, owner: string, chainId: number) {
  const normalized = JSON.stringify({
    owner: owner.toLowerCase(),
    chainId,
    pairId,
    lowerPrice: form.lowerPrice,
    upperPrice: form.upperPrice,
    gridMode: form.gridMode,
    gridCount: Number(form.gridCount),
    tradeSizeQuote: form.tradeSizeQuote,
    triggerPrice: form.triggerPrice || null,
    stopLossPrice: form.stopLossPrice || null,
    takeProfitPrice: form.takeProfitPrice || null,
    executionIntervalSec: Number(form.executionIntervalSec),
    maxSlippageBps: Number(form.maxSlippageBps),
  });
  return keccak256(stringToBytes(normalized));
}

function tryParseAmount(value: string, decimals: number) {
  try {
    return parseUnits(value || '0', decimals);
  } catch {
    return null;
  }
}

function amountIsNegative(value: string) {
  return value.trim().startsWith('-');
}

function TokenLogo({ symbol, src, className = '' }: { symbol: string; src?: string; className?: string }) {
  return (
    <span className={`grid place-items-center overflow-hidden rounded-full border border-white/10 bg-[#0B1114] ${className}`}>
      {src ? (
        // External token assets are intentionally rendered with img so the dapp can use official token-hosted logos.
        <img src={src} alt={`${symbol} logo`} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="text-[9px] font-mono font-bold text-[#C2E812]">{symbol.slice(0, 3)}</span>
      )}
    </span>
  );
}

function PairLogos({ pair, size = 'md' }: { pair?: GridPairConfig; size?: 'sm' | 'md' }) {
  const iconSize = size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  const quoteOffset = size === 'sm' ? '-ml-2' : '-ml-2.5';
  const baseSymbol = pair?.baseSymbol || 'BASE';
  const quoteSymbol = pair?.quoteSymbol || 'USD';

  return (
    <span className="flex shrink-0 items-center">
      <TokenLogo symbol={baseSymbol} src={pair?.baseLogoUrl} className={`${iconSize} z-10`} />
      <TokenLogo symbol={quoteSymbol} src={pair?.quoteLogoUrl} className={`${iconSize} ${quoteOffset}`} />
    </span>
  );
}

export function GridTradingDashboard() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { config, chainId } = useNetwork();
  const { writeContractAsync } = useWriteContract();

  const [depositAmount, setDepositAmount] = useState('20');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawTokenSide, setWithdrawTokenSide] = useState<'quote' | 'base'>('quote');
  const [allocationAmount, setAllocationAmount] = useState('10');
  const [gasReserveAmount, setGasReserveAmount] = useState('2');
  const [form, setForm] = useState<StrategyForm>(DEFAULT_FORM);
  const [strategyId, setStrategyId] = useState<string>('');
  const [importStrategyId, setImportStrategyId] = useState('');
  const [queueJobs, setQueueJobs] = useState<ExecutionJob[]>([]);
  const [pairs, setPairs] = useState<GridPairConfig[]>([]);
  const [selectedPairId, setSelectedPairId] = useState('');
  const [pairMenuOpen, setPairMenuOpen] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [error, setError] = useState('');
  const pairMenuRef = useRef<HTMLDivElement | null>(null);

  const gridVault = config.gridVault;
  const strategyManager = config.gridStrategyManager;
  const selectedPair = useMemo(
    () => pairs.find((pair) => pair.pairId === selectedPairId) ?? pairs[0],
    [pairs, selectedPairId],
  );
  const quoteToken = selectedPair?.quoteToken || config.asset;
  const baseToken = selectedPair?.baseToken;
  const quoteSymbol = selectedPair?.quoteSymbol || 'USDC';
  const baseSymbol = selectedPair?.baseSymbol || 'Base';
  const baseDecimals = selectedPair?.baseDecimals || 18;
  const pairId = selectedPair?.pairId || keccak256(stringToBytes('AERO-USDC'));
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

  const { data: availableBaseRaw, refetch: refetchBaseAvailable } = useReadContract({
    address: gridVault,
    abi: GRID_VAULT_ABI,
    functionName: 'availableBalance',
    args: address && isConfigured(baseToken) ? [address, baseToken] : undefined,
    query: { enabled: Boolean(address && isConfigured(gridVault) && isConfigured(baseToken)) },
  });

  const { data: strategyRaw, refetch: refetchStrategy } = useReadContract({
    address: strategyManager,
    abi: GRID_STRATEGY_MANAGER_ABI,
    functionName: 'getStrategy',
    args: strategyId ? [strategyId as `0x${string}`] : undefined,
    query: { enabled: Boolean(strategyId && isConfigured(strategyManager)) },
  });

  const { data: pairConfigRaw, refetch: refetchPairConfig } = useReadContract({
    address: strategyManager,
    abi: GRID_STRATEGY_MANAGER_ABI,
    functionName: 'pairConfig',
    args: pairId ? [pairId as `0x${string}`] : undefined,
    query: { enabled: Boolean(pairId && isConfigured(strategyManager)) },
  });

  const { data: testingGasSubsidyModeRaw, refetch: refetchTestingGasSubsidyMode } = useReadContract({
    address: strategyManager,
    abi: GRID_STRATEGY_MANAGER_ABI,
    functionName: 'testingGasSubsidyMode',
    query: { enabled: isConfigured(strategyManager) },
  });

  const strategy = strategyRaw as any;
  const pairConfig = pairConfigRaw as any;
  const pairConfigEnabled = pairConfig?.enabled ?? pairConfig?.[2];
  const onchainPairEnabled = pairConfig ? Boolean(pairConfigEnabled) : selectedPair?.enabled !== false;
  const testingGasSubsidyMode = Boolean(testingGasSubsidyModeRaw);
  const currentStatus = strategy ? STATUS_LABELS[Number(strategy.status)] ?? 'Unknown' : 'No Strategy';
  const strategyOwner = strategy?.owner as string | undefined;
  const isCurrentStrategyOwner =
    Boolean(strategyOwner && address && strategyOwner.toLowerCase() === address.toLowerCase());

  const refreshBalances = useCallback(async () => {
    await Promise.all([
      refetchTokenBalance(),
      refetchAllowance(),
      refetchAvailable(),
      refetchBaseAvailable(),
      refetchStrategy(),
      refetchPairConfig(),
      refetchTestingGasSubsidyMode(),
    ]);
  }, [
    refetchAllowance,
    refetchAvailable,
    refetchBaseAvailable,
    refetchPairConfig,
    refetchStrategy,
    refetchTestingGasSubsidyMode,
    refetchTokenBalance,
  ]);

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

  const fetchPairs = useCallback(async () => {
    const res = await fetch(`/api/grid/pairs?chainId=${chainId}`);
    if (!res.ok) return;
    const body = await res.json();
    const nextPairs = Array.isArray(body.pairs) ? body.pairs : [];
    setPairs(nextPairs);
    setSelectedPairId((current) => current || nextPairs[0]?.pairId || '');
  }, [chainId]);

  useEffect(() => {
    fetchPairs();
  }, [fetchPairs]);

  useEffect(() => {
    if (!pairMenuOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      if (!pairMenuRef.current?.contains(event.target as Node)) {
        setPairMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [pairMenuOpen]);

  useEffect(() => {
    const stored = address ? localStorage.getItem(`ys_grid_strategy_${address}_${chainId}`) : null;
    const fallback = stored || DEFAULT_IMPORTED_STRATEGY_ID;
    if (fallback && isStrategyId(fallback)) {
      setStrategyId(fallback);
      setImportStrategyId(fallback);
    }
  }, [address, chainId]);

  useEffect(() => {
    const strategyPairId = strategy?.pairId as string | undefined;
    if (!strategyPairId || pairs.length === 0) return;
    const pairExists = pairs.some((pair) => pair.pairId.toLowerCase() === strategyPairId.toLowerCase());
    if (pairExists && selectedPairId.toLowerCase() !== strategyPairId.toLowerCase()) {
      setSelectedPairId(strategyPairId);
    }
  }, [pairs, selectedPairId, strategy?.pairId]);

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

  const handleLoadStrategy = () => {
    setError('');
    const nextId = importStrategyId.trim();
    if (!isStrategyId(nextId)) {
      setError('Enter a valid 32-byte strategy id.');
      return;
    }
    setStrategyId(nextId);
    if (address) localStorage.setItem(`ys_grid_strategy_${address}_${chainId}`, nextId);
  };

  const handleApprove = () =>
    runTx(`Approving ${quoteSymbol}`, async () => {
      if (!contractsReady) throw new Error('Grid contracts are not configured.');
      if (depositError) throw new Error(depositError);
      const amount = parseUnits(depositAmount || '0', quoteDecimals);
      await writeContractAsync({
        address: quoteToken,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [gridVault, amount],
      });
    });

  const handleDeposit = () =>
    runTx(`Depositing ${quoteSymbol}`, async () => {
      if (!contractsReady) throw new Error('Grid contracts are not configured.');
      if (depositError) throw new Error(depositError);
      const amount = parseUnits(depositAmount || '0', quoteDecimals);
      await writeContractAsync({
        address: gridVault,
        abi: GRID_VAULT_ABI,
        functionName: 'deposit',
        args: [quoteToken, amount],
      });
    });

  const handleWithdraw = () =>
    runTx(`Withdrawing ${withdrawTokenSide === 'quote' ? quoteSymbol : baseSymbol}`, async () => {
      if (!contractsReady) throw new Error('Grid contracts are not configured.');
      if (withdrawError) throw new Error(withdrawError);
      const token = withdrawTokenSide === 'quote' ? quoteToken : baseToken;
      const decimals = withdrawTokenSide === 'quote' ? quoteDecimals : baseDecimals;
      if (!isConfigured(token)) throw new Error('Selected withdrawal token is not configured.');
      const amount = parseUnits(withdrawAmount || '0', decimals);
      if (amount <= BigInt(0)) throw new Error('Enter a withdrawal amount greater than zero.');
      await writeContractAsync({
        address: gridVault,
        abi: GRID_VAULT_ABI,
        functionName: 'withdraw',
        args: [token, amount],
      });
      setWithdrawAmount('');
    });

  const handleCreateStrategy = () =>
    runTx('Creating strategy', async () => {
      if (!address || !publicClient || !contractsReady) throw new Error('Wallet or grid contracts are not ready.');
      if (createStrategyError) throw new Error(createStrategyError);

      const payloadHash = createPayloadHash(form, pairId, address, chainId);
      const txHash = await writeContractAsync({
        address: strategyManager,
        abi: GRID_STRATEGY_MANAGER_ABI,
        functionName: 'createStrategy',
        args: [pairId as `0x${string}`, payloadHash],
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
            await fetch('/api/grid/strategies', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                strategyId: createdId,
                owner: address,
                chainId,
                pairId,
                status: 'draft',
                lowerPrice: Number(form.lowerPrice),
                upperPrice: Number(form.upperPrice),
                gridMode: form.gridMode,
                gridCount: Number(form.gridCount),
                tradeSizeQuote: form.tradeSizeQuote,
                triggerPrice: form.triggerPrice || null,
                stopLossPrice: form.stopLossPrice || null,
                takeProfitPrice: form.takeProfitPrice || null,
                maxSlippageBps: Number(form.maxSlippageBps),
                executionIntervalSec: Number(form.executionIntervalSec),
              }),
            });
            return;
          }
        } catch {}
      }
      throw new Error('StrategyCreated event was not found in the transaction receipt.');
    });

  const handleAllocate = () =>
    runTx('Allocating capital', async () => {
      if (!strategyId || !contractsReady) throw new Error('Create a strategy before allocation.');
      if (allocateError) throw new Error(allocateError);
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
      await fetch('/api/grid/strategies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId, status: 'funded' }),
      });
    });

  const handleEnable = () =>
    runTx('Enabling grid trading', async () => {
      if (!strategyId || !contractsReady) throw new Error('Create and allocate a strategy first.');
      if (enableError) throw new Error(enableError);
      await writeContractAsync({
        address: strategyManager,
        abi: GRID_STRATEGY_MANAGER_ABI,
        functionName: 'enableStrategy',
        args: [strategyId as `0x${string}`],
      });
      await fetch('/api/grid/strategies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId, status: 'active' }),
      });
    });

  const handlePause = () =>
    runTx('Pausing grid trading', async () => {
      if (!strategyId || !contractsReady) throw new Error('No strategy selected.');
      if (pauseError) throw new Error(pauseError);
      await writeContractAsync({
        address: strategyManager,
        abi: GRID_STRATEGY_MANAGER_ABI,
        functionName: 'pauseStrategy',
        args: [strategyId as `0x${string}`],
      });
      await fetch('/api/grid/strategies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId, status: 'paused' }),
      });
    });

  const handleClose = () =>
    runTx('Closing strategy', async () => {
      if (!strategyId || !contractsReady) throw new Error('No strategy selected.');
      if (closeError) throw new Error(closeError);
      await writeContractAsync({
        address: strategyManager,
        abi: GRID_STRATEGY_MANAGER_ABI,
        functionName: 'closeStrategy',
        args: [strategyId as `0x${string}`],
      });
      await fetch('/api/grid/strategies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId, status: 'closed' }),
      });
    });

  const allowance = Number(formatUnits((allowanceRaw as bigint | undefined) ?? BigInt(0), quoteDecimals));
  const depositValue = Number(depositAmount || 0);
  const needsApproval = allowance < depositValue;
  const tokenBalance = formatUnits((tokenBalanceRaw as bigint | undefined) ?? BigInt(0), quoteDecimals);
  const availableBalance = formatUnits((availableRaw as bigint | undefined) ?? BigInt(0), quoteDecimals);
  const availableBaseBalance = formatUnits((availableBaseRaw as bigint | undefined) ?? BigInt(0), baseDecimals);
  const depositRaw = tryParseAmount(depositAmount, quoteDecimals);
  const allocationRaw = tryParseAmount(allocationAmount, quoteDecimals);
  const gasReserveRaw = tryParseAmount(gasReserveAmount, quoteDecimals);
  const withdrawAmountRaw = tryParseAmount(withdrawAmount, withdrawTokenSide === 'quote' ? quoteDecimals : baseDecimals);
  const depositError =
    depositRaw === null
      ? 'Enter a valid deposit amount.'
      : amountIsNegative(depositAmount) || depositRaw < BigInt(0)
        ? 'Deposit amount cannot be negative.'
        : depositRaw === BigInt(0)
          ? ''
          : depositRaw > ((tokenBalanceRaw as bigint | undefined) ?? BigInt(0))
            ? `Wallet balance is only ${Number(tokenBalance).toFixed(2)} ${quoteSymbol}.`
            : '';
  const canSubmitGridDeposit = contractsReady && depositRaw !== null && depositRaw > BigInt(0) && !depositError;
  const freeQuoteRaw = (availableRaw as bigint | undefined) ?? BigInt(0);
  const freeBaseRaw = (availableBaseRaw as bigint | undefined) ?? BigInt(0);
  const selectedFreeWithdrawRaw = withdrawTokenSide === 'quote' ? freeQuoteRaw : freeBaseRaw;
  const pairMinGasReserveRaw =
    (pairConfig?.minGasReserveQuote as bigint | undefined) ??
    (pairConfig?.[3] as bigint | undefined) ??
    tryParseAmount(selectedPair?.minGasReserveQuote || '0', quoteDecimals) ??
    BigInt(0);
  const withdrawSymbol = withdrawTokenSide === 'quote' ? quoteSymbol : baseSymbol;
  const withdrawAvailable = withdrawTokenSide === 'quote' ? availableBalance : availableBaseBalance;
  const totalAllocationRaw =
    allocationRaw !== null && gasReserveRaw !== null ? allocationRaw + gasReserveRaw : null;
  const strategyGasReserveRaw = (strategy?.gasReserveQuote as bigint | undefined) ?? BigInt(0);
  const nextGasReserveRaw =
    gasReserveRaw !== null && (currentStatus === 'Draft' || currentStatus === 'Funded')
      ? strategyGasReserveRaw + gasReserveRaw
      : strategyGasReserveRaw;
  const hasSufficientGasReserve = testingGasSubsidyMode || nextGasReserveRaw >= pairMinGasReserveRaw;
  const lifecycleOwnerError =
    strategy && !isCurrentStrategyOwner
      ? `This strategy belongs to ${short(strategyOwner)}. Connect that wallet before changing it.`
      : '';
  const allocateError =
    !strategyId
      ? 'Create or load a strategy first.'
      : lifecycleOwnerError ||
        (!onchainPairEnabled ? 'This trading pair is disabled.' : '') ||
        (currentStatus !== 'Draft' && currentStatus !== 'Funded' ? 'Allocation is only available for Draft or Funded strategies.' : '') ||
        (allocationRaw === null || gasReserveRaw === null ? 'Enter valid capital and gas reserve amounts.' : '') ||
        (amountIsNegative(allocationAmount) || amountIsNegative(gasReserveAmount) ? 'Trading capital and gas reserve cannot be negative.' : '') ||
        (allocationRaw !== null && allocationRaw <= BigInt(0) ? 'Trading capital must be greater than zero.' : '') ||
        (totalAllocationRaw !== null && totalAllocationRaw > freeQuoteRaw
          ? `Free ${quoteSymbol} is too low. Available ${Number(availableBalance).toFixed(2)}, needed ${Number(formatUnits(totalAllocationRaw, quoteDecimals)).toFixed(2)}.`
          : '');
  const enableError =
    !strategyId
      ? 'Create or load a strategy first.'
      : lifecycleOwnerError ||
        (!onchainPairEnabled ? 'This trading pair is disabled.' : '') ||
        (currentStatus !== 'Funded' && currentStatus !== 'Paused' ? 'Enable requires a Funded or Paused strategy.' : '') ||
        (!hasSufficientGasReserve
          ? `Gas reserve must be at least ${formatUnits(pairMinGasReserveRaw, quoteDecimals)} ${quoteSymbol}.`
          : '');
  const pauseError =
    !strategyId
      ? 'Create or load a strategy first.'
      : lifecycleOwnerError ||
        (currentStatus !== 'Active' && currentStatus !== 'GasPaused' ? 'Only Active or GasPaused strategies can be paused.' : '');
  const closeError =
    !strategyId
      ? 'Create or load a strategy first.'
      : lifecycleOwnerError ||
        (currentStatus === 'Active' ? 'Pause the strategy before closing it.' : '') ||
        (currentStatus === 'Closed' ? 'Strategy is already closed.' : '');
  const withdrawError =
    withdrawAmountRaw === null
      ? 'Enter a valid withdrawal amount.'
      : amountIsNegative(withdrawAmount) || withdrawAmountRaw < BigInt(0)
        ? 'Withdrawal amount cannot be negative.'
      : withdrawAmountRaw <= BigInt(0)
        ? 'Enter a withdrawal amount greater than zero.'
        : withdrawAmountRaw > selectedFreeWithdrawRaw
          ? `Maximum withdrawal is ${Number(withdrawAvailable).toFixed(withdrawTokenSide === 'quote' ? 2 : 4)} ${withdrawSymbol}.`
          : '';
  const allocationStatusOpen = currentStatus === 'Draft' || currentStatus === 'Funded';
  const allocationFormEnabled = Boolean(strategyId && allocationStatusOpen && !lifecycleOwnerError && onchainPairEnabled);
  const maxTradingCapitalRaw =
    gasReserveRaw !== null && freeQuoteRaw > gasReserveRaw ? freeQuoteRaw - gasReserveRaw : BigInt(0);
  const maxGasReserveRaw =
    allocationRaw !== null && freeQuoteRaw > allocationRaw ? freeQuoteRaw - allocationRaw : BigInt(0);
  const maxTradingCapital = formatUnits(maxTradingCapitalRaw, quoteDecimals);
  const maxGasReserve = formatUnits(maxGasReserveRaw, quoteDecimals);
  const tradingCapitalFieldError =
    amountIsNegative(allocationAmount)
      ? 'Trading capital cannot be negative.'
      : allocationRaw !== null && allocationRaw > maxTradingCapitalRaw
      ? `Max trading capital is ${Number(maxTradingCapital).toFixed(2)} ${quoteSymbol} after gas reserve.`
      : '';
  const gasReserveFieldError =
    amountIsNegative(gasReserveAmount)
      ? 'Gas reserve cannot be negative.'
      : gasReserveRaw !== null && gasReserveRaw > maxGasReserveRaw
      ? `Max gas reserve is ${Number(maxGasReserve).toFixed(2)} ${quoteSymbol} after trading capital.`
      : !testingGasSubsidyMode && gasReserveRaw !== null && gasReserveRaw < pairMinGasReserveRaw
        ? `Gas reserve should be at least ${formatUnits(pairMinGasReserveRaw, quoteDecimals)} ${quoteSymbol} before enabling.`
        : '';
  const negativeStrategyField = (Object.entries(form) as Array<[keyof StrategyForm, string]>).find(
    ([, value]) => amountIsNegative(value),
  );
  const createStrategyError =
    negativeStrategyField
      ? 'Grid strategy values cannot be negative.'
      : !onchainPairEnabled
        ? `${selectedPair?.label || 'Selected pair'} is not enabled on-chain yet.`
        : '';
  const canCreateStrategy = contractsReady && !createStrategyError;
  const canAllocate = contractsReady && !allocateError;
  const canEnable = contractsReady && !enableError;
  const canPause = contractsReady && !pauseError;
  const canClose = contractsReady && !closeError;
  const canWithdraw =
    contractsReady &&
    !withdrawError &&
    withdrawAmountRaw !== null &&
    withdrawAmountRaw <= selectedFreeWithdrawRaw;
  const lifecycleHint =
    lifecycleOwnerError ||
    (!strategyId
      ? 'Create or load a strategy first.'
      : currentStatus === 'Active'
        ? 'Active strategy loaded. Pause it before closing or reallocating capital.'
        : currentStatus === 'Closed'
          ? 'This strategy is closed. Free released funds can be withdrawn from the Capital panel.'
          : allocateError || enableError || pauseError || closeError);
  const hasGridCapital = freeQuoteRaw > BigInt(0) || Boolean(strategy);
  const hasGridStrategy = Boolean(strategyId);
  const isGridLive = currentStatus === 'Active';

  return (
    <div className="ys-card p-5 sm:p-8 flex flex-col gap-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="p-2.5 rounded-xl bg-[#C2E812]/10 border border-[#C2E812]/15">
            <Gauge size={22} className="text-[#C2E812]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Live Grid Engine</p>
            <div className="mt-1 flex items-center gap-3">
              <PairLogos pair={selectedPair} />
              <h3 className="text-2xl font-heading font-bold text-[#F5F7FA]">{selectedPair?.label || 'Grid'} Trading</h3>
            </div>
            <p className="mt-2 max-w-2xl text-xs font-mono leading-relaxed text-[#8B949E] uppercase tracking-[0.16em]">
              Deposit grid capital, seal strategy parameters, allocate gas reserve, and enable the shared Acurast executor.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-[10px] font-mono font-bold uppercase tracking-widest sm:grid-cols-4 lg:min-w-[520px]">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[#484F58]">Wallet {quoteSymbol}</p>
            <p className="mt-2 text-[#F5F7FA]">{Number(tokenBalance).toFixed(2)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[#484F58]">Free {quoteSymbol}</p>
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

      <div className="grid grid-cols-1 gap-3 text-[10px] font-mono font-bold uppercase tracking-widest md:grid-cols-3">
        {[
          ['1', 'Fund', hasGridCapital ? 'Ready' : `Add ${quoteSymbol}`],
          ['2', 'Configure', hasGridStrategy ? 'Strategy set' : 'Create strategy'],
          ['3', 'Run', isGridLive ? 'Active' : 'Enable when ready'],
        ].map(([step, label, value]) => {
          const active =
            (step === '1' && hasGridCapital) ||
            (step === '2' && hasGridStrategy) ||
            (step === '3' && isGridLive);
          return (
            <div
              key={step}
              className={`flex items-center gap-3 rounded-xl border p-4 ${
                active ? 'border-[#C2E812]/20 bg-[#C2E812]/[0.04]' : 'border-white/10 bg-white/[0.025]'
              }`}
            >
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                  active ? 'bg-[#C2E812] text-[#030605]' : 'border border-white/10 text-[#8B949E]'
                }`}
              >
                {step}
              </span>
              <span className="min-w-0">
                <span className="block text-[#F5F7FA]">{label}</span>
                <span className="mt-1 block truncate text-[#484F58]">{value}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-5 flex items-center gap-3">
            <Wallet size={17} className="text-[#C2E812]" />
            <h4 className="font-heading text-base font-bold text-[#F5F7FA]">Capital</h4>
          </div>
          <div className="space-y-4">
            <label className="flex flex-col gap-2">
              <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Trading Pair</span>
              <div ref={pairMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setPairMenuOpen((open) => !open)}
                  className={`flex h-12 w-full items-center justify-between rounded-xl border px-4 text-left transition-all ${
                    pairMenuOpen
                      ? 'border-[#C2E812]/50 bg-[#C2E812]/[0.04] shadow-[0_0_0_1px_rgba(194,232,18,0.12)]'
                      : 'border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.06]'
                  }`}
                  aria-expanded={pairMenuOpen}
                  aria-haspopup="listbox"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <PairLogos pair={selectedPair} />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-mono font-bold uppercase tracking-widest text-[#F5F7FA]">
                        {selectedPair?.label || 'Select Pair'}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] font-mono font-bold uppercase tracking-widest text-[#484F58]">
                        {baseSymbol} / {quoteSymbol}
                      </span>
                    </span>
                  </span>
                  <ChevronDown
                    size={16}
                    className={`shrink-0 text-[#8B949E] transition-transform ${pairMenuOpen ? 'rotate-180 text-[#C2E812]' : ''}`}
                  />
                </button>

                {pairMenuOpen && (
                  <div
                    role="listbox"
                    className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-[#070B0E] p-2 shadow-2xl shadow-black/40 ring-1 ring-[#C2E812]/10"
                  >
                    {pairs.length === 0 ? (
                      <div className="rounded-lg px-3 py-3 text-[10px] font-mono font-bold uppercase tracking-widest text-[#484F58]">
                        No pairs configured
                      </div>
                    ) : (
                      pairs.map((pair) => {
                        const active = pair.pairId === selectedPair?.pairId;
                        return (
                          <button
                            key={pair.pairId}
                            type="button"
                            role="option"
                            aria-selected={active}
                            onClick={() => {
                              setSelectedPairId(pair.pairId);
                              setPairMenuOpen(false);
                            }}
                            className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition-all ${
                              active
                                ? 'border border-[#C2E812]/20 bg-[#C2E812]/10 text-[#F5F7FA]'
                                : 'border border-transparent text-[#8B949E] hover:border-white/10 hover:bg-white/[0.05] hover:text-[#F5F7FA]'
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-3">
                              <PairLogos pair={pair} size="sm" />
                              <span className="min-w-0">
                                <span className="block text-xs font-mono font-bold uppercase tracking-widest">{pair.label}</span>
                                <span className="mt-1 block truncate text-[10px] font-mono font-bold uppercase tracking-widest text-[#484F58]">
                                  {pair.baseSymbol} base / {pair.quoteSymbol} quote
                                </span>
                              </span>
                            </span>
                            {active && <Check size={15} className="shrink-0 text-[#C2E812]" />}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </label>

            <div className="rounded-lg border border-white/10 bg-black/20 px-4 py-3">
              <div className="grid grid-cols-2 gap-3 text-[10px] font-mono font-bold uppercase tracking-widest">
                <div>
                  <p className="text-[#484F58]">Base</p>
                  <p className="mt-1 text-[#F5F7FA]">{baseSymbol}</p>
                  <p className="mt-1 text-[#484F58]">Free {Number(availableBaseBalance).toFixed(4)}</p>
                </div>
                <div>
                  <p className="text-[#484F58]">Quote</p>
                  <p className="mt-1 text-[#F5F7FA]">{quoteSymbol}</p>
                  <p className="mt-1 text-[#484F58]">Free {Number(availableBalance).toFixed(2)}</p>
                </div>
              </div>
              <p className="mt-3 truncate text-[10px] font-mono font-bold uppercase tracking-widest text-[#484F58]">
                Price pool <span className="text-[#8B949E]">{short(selectedPair?.poolAddress)}</span>
              </p>
            </div>

            <label className="flex flex-col gap-2">
              <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Deposit Amount</span>
              <div className="relative">
                <input
                  value={depositAmount}
                  onChange={(event) => setDepositAmount(event.target.value)}
                  className="ys-input w-full pr-20"
                  type="number"
                  min="0"
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E]">
                  {quoteSymbol}
                </span>
              </div>
              {depositError && depositAmount ? (
                <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#FF4466]">
                  {depositError}
                </span>
              ) : null}
            </label>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button className="ys-btn-secondary h-12" disabled={Boolean(busyLabel) || !canSubmitGridDeposit || !needsApproval} onClick={handleApprove}>
              {needsApproval ? 'Approve' : 'Approved'}
            </button>
            <button className="ys-btn-primary h-12" disabled={Boolean(busyLabel) || !canSubmitGridDeposit || needsApproval} onClick={handleDeposit}>
              Deposit
            </button>
          </div>
          <details className="group mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E] transition-colors hover:text-[#F5F7FA]">
              <span>Withdraw free balance</span>
              <span className="text-[#484F58] group-open:text-[#C2E812]">
                {Number(withdrawAvailable).toFixed(withdrawTokenSide === 'quote' ? 2 : 4)} {withdrawSymbol}
              </span>
            </summary>
            <div className="mt-4">
            <div className="grid grid-cols-2 gap-2">
              {(['quote', 'base'] as const).map((side) => {
                const active = withdrawTokenSide === side;
                const symbol = side === 'quote' ? quoteSymbol : baseSymbol;
                return (
                  <button
                    key={side}
                    type="button"
                    onClick={() => setWithdrawTokenSide(side)}
                    className={`h-10 rounded-xl text-[10px] font-mono font-bold uppercase tracking-widest transition-all ${
                      active
                        ? 'bg-[#C2E812] text-[#030605]'
                        : 'border border-white/10 bg-white/5 text-[#8B949E] hover:text-[#F5F7FA]'
                    }`}
                  >
                    {symbol}
                  </button>
                );
              })}
            </div>
            <label className="mt-4 flex flex-col gap-2">
              <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Withdraw Amount</span>
              <div className="relative">
                <input
                  value={withdrawAmount}
                  onChange={(event) => setWithdrawAmount(event.target.value)}
                  className="ys-input w-full pr-20"
                  type="number"
                  min="0"
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E]">
                  {withdrawSymbol}
                </span>
              </div>
            </label>
            <button className="ys-btn-secondary mt-3 h-12 w-full" disabled={Boolean(busyLabel) || !canWithdraw} onClick={handleWithdraw}>
              <ArrowDownToLine size={15} /> Withdraw
            </button>
            {withdrawError && withdrawAmount ? (
              <p className="mt-3 text-[10px] font-mono font-bold uppercase tracking-widest text-[#FF4466]">
                {withdrawError}
              </p>
            ) : null}
            </div>
          </details>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-5 flex items-center gap-3">
            <BookOpen size={17} className="text-[#C2E812]" />
            <h4 className="font-heading text-base font-bold text-[#F5F7FA]">Accounting</h4>
          </div>
          <div className="grid grid-cols-2 gap-3 text-[10px] font-mono font-bold uppercase tracking-widest">
            <div>
              <p className="text-[#484F58]">Quote</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? Number(formatUnits(strategy.quoteBalance, quoteDecimals)).toFixed(2) : '0.00'}</p>
            </div>
            <div>
              <p className="text-[#484F58]">Base</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? Number(formatUnits(strategy.baseBalance, selectedPair?.baseDecimals || 18)).toFixed(4) : '0.0000'}</p>
            </div>
            <div>
              <p className="text-[#484F58]">Gas Reserve</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? Number(formatUnits(strategy.gasReserveQuote, quoteDecimals)).toFixed(2) : '0.00'}</p>
            </div>
            <div>
              <p className="text-[#484F58]">Gas Spent</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? Number(formatUnits(strategy.gasSpentQuote, quoteDecimals)).toFixed(2) : '0.00'}</p>
            </div>
            <div>
              <p className="text-[#484F58]">Grid Level</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy ? String(strategy.currentGridLevel) : '0'}</p>
            </div>
            <div>
              <p className="text-[#484F58]">Last Exec</p>
              <p className="mt-2 text-[#F5F7FA]">{strategy?.lastExecutionAt ? new Date(Number(strategy.lastExecutionAt) * 1000).toLocaleTimeString() : 'None'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <h4 className="mb-5 font-heading text-base font-bold text-[#F5F7FA]">Grid Setup</h4>
          <p className="mb-5 text-[10px] font-mono font-bold uppercase tracking-widest text-[#484F58]">
            Price limits are {baseSymbol} price quoted in {quoteSymbol}.
          </p>
          <div className="grid grid-cols-2 gap-4">
            {([
              ['lowerPrice', `Lower ${quoteSymbol}`],
              ['upperPrice', `Upper ${quoteSymbol}`],
              ['gridCount', 'Grids'],
              ['tradeSizeQuote', `Trade ${quoteSymbol}`],
            ] as Array<[Exclude<keyof StrategyForm, 'gridMode'>, string]>).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-2">
                <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">{label}</span>
                <input
                  value={form[key]}
                  onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
                  className="ys-input w-full"
                  type="number"
                  min="0"
                />
              </label>
            ))}
          </div>
          <details className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
            <summary className="cursor-pointer list-none text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E] transition-colors hover:text-[#F5F7FA]">
              Advanced protection settings
            </summary>
            <div className="mt-4 grid grid-cols-2 gap-4">
              {([
                ['triggerPrice', `Trigger ${quoteSymbol}`],
                ['stopLossPrice', 'Stop Loss'],
                ['takeProfitPrice', 'Take Profit'],
                ['maxSlippageBps', 'Slippage Bps'],
              ] as Array<[Exclude<keyof StrategyForm, 'gridMode'>, string]>).map(([key, label]) => (
                <label key={key} className="flex flex-col gap-2">
                  <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">{label}</span>
                  <input
                    value={form[key]}
                    onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
                    className="ys-input w-full"
                    type="number"
                    min="0"
                  />
                </label>
              ))}
            </div>
          </details>
          <div className="mt-5">
            <p className="mb-3 text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Grid Mode</p>
            <div className="grid grid-cols-2 gap-2">
              {(['arithmetic', 'geometric'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, gridMode: mode }))}
                  className={`h-10 rounded-xl text-[10px] font-mono font-bold uppercase tracking-widest transition-all ${
                    form.gridMode === mode
                      ? 'bg-[#C2E812] text-[#030605]'
                      : 'border border-white/10 bg-white/5 text-[#8B949E] hover:text-[#F5F7FA]'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
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
          {createStrategyError && (
            <div className="mt-5 rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-3 text-[10px] font-mono font-bold uppercase tracking-widest text-amber-200">
              {createStrategyError}
            </div>
          )}
          <button className="ys-btn-primary mt-5 h-12 w-full" disabled={Boolean(busyLabel) || !canCreateStrategy} onClick={handleCreateStrategy}>
            <Plus size={16} /> Create Strategy
          </button>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
          <h4 className="mb-5 font-heading text-base font-bold text-[#F5F7FA]">Start & Manage</h4>
          <details className="mb-5 rounded-xl border border-white/10 bg-black/20 p-4">
            <summary className="cursor-pointer list-none text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E] transition-colors hover:text-[#F5F7FA]">
              Load existing strategy
            </summary>
            <div className="mt-4">
            <label className="flex flex-col gap-2">
              <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Load On-chain Strategy</span>
              <input
                value={importStrategyId}
                onChange={(event) => setImportStrategyId(event.target.value)}
                className="ys-input w-full font-mono text-xs"
                placeholder="0x..."
              />
            </label>
            <button className="ys-btn-secondary mt-3 h-11 w-full" disabled={Boolean(busyLabel)} onClick={handleLoadStrategy}>
              Load Strategy ID
            </button>
            </div>
          </details>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-2">
              <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Trading Capital</span>
              <input
                value={allocationAmount}
                onChange={(event) => setAllocationAmount(event.target.value)}
                className="ys-input w-full disabled:cursor-not-allowed disabled:opacity-50"
                type="number"
                min="0"
                max={maxTradingCapital}
                disabled={!allocationFormEnabled || Boolean(busyLabel)}
              />
              <span className={`text-[10px] font-mono font-bold uppercase tracking-widest ${tradingCapitalFieldError ? 'text-[#FF4466]' : 'text-[#484F58]'}`}>
                {tradingCapitalFieldError || `Available after gas: ${Number(maxTradingCapital).toFixed(2)} ${quoteSymbol}`}
              </span>
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Gas Reserve</span>
              <input
                value={gasReserveAmount}
                onChange={(event) => setGasReserveAmount(event.target.value)}
                className="ys-input w-full disabled:cursor-not-allowed disabled:opacity-50"
                type="number"
                min="0"
                max={maxGasReserve}
                disabled={!allocationFormEnabled || Boolean(busyLabel)}
              />
              <span className={`text-[10px] font-mono font-bold uppercase tracking-widest ${gasReserveFieldError ? 'text-[#FF4466]' : 'text-[#484F58]'}`}>
                {gasReserveFieldError || `Required to run: ${testingGasSubsidyMode ? 'subsidized' : `${formatUnits(pairMinGasReserveRaw, quoteDecimals)} ${quoteSymbol}`}`}
              </span>
            </label>
          </div>
          {lifecycleHint && (
            <div className="mt-4 rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-3 text-[10px] font-mono font-bold uppercase tracking-widest text-amber-200">
              {lifecycleHint}
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 text-[10px] font-mono font-bold uppercase tracking-widest">
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <p className="text-[#484F58]">{allocationFormEnabled ? 'Max Allocate' : 'Allocation'}</p>
              <p className="mt-1 text-[#F5F7FA]">
                {allocationFormEnabled ? `${Number(availableBalance).toFixed(2)} ${quoteSymbol}` : currentStatus}
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <p className="text-[#484F58]">Min Gas Reserve</p>
              <p className="mt-1 text-[#F5F7FA]">
                {testingGasSubsidyMode ? 'Subsidized' : `${formatUnits(pairMinGasReserveRaw, quoteDecimals)} ${quoteSymbol}`}
              </p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <button className="ys-btn-secondary h-12" disabled={Boolean(busyLabel) || !canAllocate} onClick={handleAllocate}>
              Allocate
            </button>
            <button className="ys-btn-primary h-12" disabled={Boolean(busyLabel) || !canEnable} onClick={handleEnable}>
              <Play size={15} /> Enable
            </button>
            <button className="ys-btn-secondary h-12" disabled={Boolean(busyLabel) || !canPause} onClick={handlePause}>
              <CirclePause size={15} /> Pause
            </button>
            <button className="ys-btn-secondary h-12" disabled={Boolean(busyLabel) || !canClose} onClick={handleClose}>
              <CircleX size={15} /> Close
            </button>
          </div>

          <details className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E] transition-colors hover:text-[#F5F7FA]">
              <span>Execution logs</span>
              <span className="text-[#484F58]">{queueJobs.length}</span>
            </summary>
            <div className="mt-4">
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
                  <div key={job.id} className="rounded-lg bg-white/[0.03] px-3 py-2 text-[10px] font-mono uppercase tracking-widest">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[#8B949E]">{job.side} L{job.gridLevel}</span>
                      <span className={job.status === 'confirmed' ? 'text-[#00FFA3]' : job.status === 'reverted' || job.status === 'stale' ? 'text-[#FF4466]' : 'text-[#C2E812]'}>
                        {job.status}
                      </span>
                    </div>
                    {job.txHash && (
                      <a
                        href={`${config.explorer}/tx/${job.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block truncate text-[#484F58] transition-colors hover:text-[#C2E812]"
                      >
                        {short(job.txHash)}
                      </a>
                    )}
                  </div>
                ))
              )}
            </div>
            </div>
          </details>
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
    </div>
  );
}
