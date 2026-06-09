'use client';

import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits, parseUnits } from 'viem';
import { ERC20_ABI, KEEPER_ABI, BUILDER_CODE_SUFFIX } from '@/lib/contracts';
import { ArrowDownToLine, Loader2, CheckCircle2, Wallet, Info } from 'lucide-react';
import { useNetwork } from '@/providers/NetworkProvider';

function tryParseUsdc(value: string) {
  try {
    return value ? parseUnits(value, 6) : BigInt(0);
  } catch {
    return null;
  }
}

export function DepositModule() {
  const { address, isConnected } = useAccount();
  const { config } = useNetwork();
  const KEEPER_ADDRESS = config.keeper;
  const ASSET_ADDRESS = config.asset;

  const [depositAmount, setDepositAmount] = useState('');
  const [txState, setTxState] = useState<'idle' | 'approving' | 'depositing' | 'success'>('idle');

  const { data: dynamicAssetAddress } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'asset',
    query: { enabled: !!KEEPER_ADDRESS },
  });
  const actualAssetAddress = (ASSET_ADDRESS || dynamicAssetAddress) as `0x${string}` | undefined;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: actualAssetAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address && actualAssetAddress && KEEPER_ADDRESS ? [address, KEEPER_ADDRESS] : undefined,
    query: { enabled: !!address && !!actualAssetAddress && !!KEEPER_ADDRESS },
  });

  const { data: assetBalance } = useReadContract({
    address: actualAssetAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!actualAssetAddress },
  });

  const { data: totalAssets } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'totalAssets',
    query: { enabled: !!KEEPER_ADDRESS },
  });

  const { data: maxTotalAssets } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'maxTotalAssets',
    query: { enabled: !!KEEPER_ADDRESS },
  });

  const { data: maxDepositRaw } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'maxDeposit',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!KEEPER_ADDRESS },
  });

  const { writeContractAsync } = useWriteContract();

  const ZERO = BigInt(0);

  const parsedDepositAmount = tryParseUsdc(depositAmount);
  const depositAmountParsed = parsedDepositAmount ?? ZERO;

  const currentAllowance = allowance ? (allowance as bigint) : ZERO;
  const isApprovedForAmount = depositAmountParsed > ZERO && currentAllowance >= depositAmountParsed;

  const walletBalanceRaw = assetBalance ? (assetBalance as bigint) : ZERO;
  const walletBalance = formatUnits(walletBalanceRaw, 6);
  const totalAssetsNum = totalAssets ? Number(formatUnits(totalAssets as bigint, 6)) : 0;
  const totalAssetsVal = totalAssets !== undefined ? (totalAssets as bigint) : ZERO;
  const maxTotalAssetsVal = maxTotalAssets !== undefined ? (maxTotalAssets as bigint) : ZERO;
  const maxAssetsNum = Number(formatUnits(maxTotalAssetsVal, 6));

  const remainingCapacity =
    maxTotalAssets !== undefined && totalAssets !== undefined
      ? maxTotalAssetsVal > totalAssetsVal
        ? maxTotalAssetsVal - totalAssetsVal
        : ZERO
      : ZERO;
  const maxDepositVal = maxDepositRaw !== undefined ? (maxDepositRaw as bigint) : remainingCapacity;

  const capReached = maxAssetsNum > 0 && totalAssetsNum >= maxAssetsNum;
  const depositsDisabled = maxTotalAssets !== undefined && maxTotalAssetsVal === ZERO;
  const amountExceedsCapacity =
    !depositsDisabled &&
    maxTotalAssets !== undefined &&
    totalAssets !== undefined &&
    depositAmountParsed > ZERO &&
    depositAmountParsed > remainingCapacity;
  const maxDepositableRaw =
    walletBalanceRaw < maxDepositVal ? walletBalanceRaw : maxDepositVal;
  const maxDepositable = formatUnits(maxDepositableRaw, 6);
  const amountExceedsWallet = depositAmountParsed > walletBalanceRaw;
  const amountExceedsMaxDeposit = depositAmountParsed > maxDepositVal;
  const depositError =
    parsedDepositAmount === null
      ? 'Enter a valid USDC amount.'
      : depositAmountParsed < ZERO
        ? 'Deposit amount cannot be negative.'
        : depositAmountParsed === ZERO
        ? ''
        : amountExceedsWallet
          ? `Wallet balance is only ${Number(walletBalance).toFixed(2)} USDC.`
          : amountExceedsMaxDeposit || amountExceedsCapacity
            ? `Maximum vault deposit is ${Number(formatUnits(maxDepositVal, 6)).toFixed(2)} USDC.`
            : '';

  const isLoading = txState === 'approving' || txState === 'depositing';
  const canSubmitDeposit =
    !isLoading &&
    depositAmountParsed > ZERO &&
    !capReached &&
    !depositsDisabled &&
    !depositError;

  const handleApprove = async () => {
    if (!actualAssetAddress || depositAmountParsed === ZERO) return;
    if (depositError) return;
    setTxState('approving');
    try {
      await writeContractAsync({
        address: actualAssetAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [KEEPER_ADDRESS, depositAmountParsed],
        dataSuffix: BUILDER_CODE_SUFFIX,
      });
      await refetchAllowance();
      setTxState('idle');
    } catch (e) {
      console.error(e);
      setTxState('idle');
    }
  };

  const handleDeposit = async () => {
    if (!address || !actualAssetAddress || depositAmountParsed === ZERO) return;
    if (depositError) return;
    setTxState('depositing');
    try {
      if (!isApprovedForAmount) {
        await handleApprove();
        return;
      }
      await writeContractAsync({
        address: KEEPER_ADDRESS,
        abi: KEEPER_ABI,
        functionName: 'deposit',
        args: [depositAmountParsed, address],
        dataSuffix: BUILDER_CODE_SUFFIX,
      });
      setTxState('success');
      setDepositAmount('');
      setTimeout(() => setTxState('idle'), 3000);
      await refetchAllowance();
    } catch (e) {
      console.error(e);
      setTxState('idle');
    }
  };

  if (!isConnected) {
    return (
      <div className="ys-card flex min-h-[300px] flex-col items-center justify-center gap-6 p-6 text-center sm:min-h-[350px] sm:p-12">
        <div className="w-20 h-20 rounded-3xl bg-white/5 border border-white/10 flex items-center justify-center">
          <Wallet size={32} className="text-[#484F58]" />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-heading font-bold text-[#F5F7FA] uppercase tracking-widest">Connect Wallet</h3>
          <p className="mx-auto max-w-[240px] text-[11px] font-mono uppercase leading-relaxed tracking-[0.16em] text-[#8B949E] sm:text-xs sm:tracking-widest">
            Connect your wallet to deposit into the yield vault.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ys-card relative flex h-full flex-col gap-7 p-5 sm:gap-10 sm:p-8 lg:p-12">
      <div className="absolute top-0 right-0 p-12 bg-[#C2E812]/[0.02] rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
            <ArrowDownToLine size={20} className="text-[#C2E812]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-[#484F58] sm:tracking-[0.3em]">Yield Vault</p>
            <h3 className="text-lg font-heading font-bold text-[#F5F7FA] sm:text-xl">Deposit USDC</h3>
          </div>
        </div>
        <div className="px-0 py-1.5 text-[#8B949E]">
          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] sm:tracking-[0.3em]">Yield Vault</span>
        </div>
      </div>

      <div className="space-y-5 sm:space-y-6">
        {/* Wallet Balance */}
        <div className="rounded-2xl border border-white/[0.04] bg-white/[0.02] p-4 sm:rounded-3xl sm:p-6">
          <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] mb-2">Available Balance</p>
          <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
            <span className="break-words text-3xl font-heading font-bold text-[#F5F7FA] sm:text-4xl">
              {parseFloat(walletBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className="text-lg font-heading font-bold text-[#484F58]">USDC</span>
          </div>
        </div>

        {/* Input Field */}
        <div className="flex flex-col gap-3">
          <label className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] ml-1">
            Amount to Deposit
          </label>
          <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
            <div className="relative flex-1">
              <input
                type="number"
                placeholder="0.00"
                value={depositAmount}
                onChange={e => setDepositAmount(e.target.value)}
                min="0"
                max={maxDepositable}
                className="ys-input w-full pr-16 text-xl sm:text-2xl"
              />
              <div className="absolute right-5 top-1/2 -translate-y-1/2 text-xs font-mono font-bold text-[#484F58]">USDC</div>
            </div>
            <button
              onClick={() => setDepositAmount(Number(maxDepositable).toFixed(6))}
              disabled={maxDepositableRaw === ZERO}
              className="min-h-12 rounded-2xl border border-white/10 bg-white/5 px-6 text-xs font-heading font-bold uppercase tracking-widest transition-all hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Max
            </button>
          </div>
          <div className="flex flex-col gap-1 px-1 text-[10px] font-mono font-bold uppercase tracking-widest">
            <span className={depositError ? 'text-[#FF4466]' : 'text-[#484F58]'}>
              {depositError || `Max deposit now: ${Number(maxDepositable).toFixed(2)} USDC`}
            </span>
            {depositAmountParsed > ZERO && !depositError ? (
              <span className="text-[#8B949E]">
                {isApprovedForAmount ? 'Approval ready' : 'Approval required before deposit'}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Info Notice */}
      <div className="space-y-4 mt-auto">
        {/* Deposit Cap Progress */}
        <div className="space-y-2">
          <div className="flex justify-between items-end">
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em]">Pilot Capacity</p>
            <p className="text-[10px] font-mono font-bold text-[#8B949E]">
              {depositsDisabled ? (
                <span className="text-[#FF4D4D]">PAUSED</span>
              ) : (
                <>{totalAssetsNum.toLocaleString()} / {maxAssetsNum.toLocaleString()} USDC</>
              )}
            </p>
          </div>
          <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-1000 ${depositsDisabled ? 'bg-[#FF4D4D]' : 'bg-[#C2E812]'}`}
              style={{ width: `${maxAssetsNum > 0 ? Math.min(100, (totalAssetsNum / maxAssetsNum) * 100) : 0}%` }}
            />
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-2xl border border-[#C2E812]/10 bg-[#C2E812]/[0.03] p-4 sm:gap-4 sm:p-5">
          <Info size={16} className="text-[#C2E812] flex-shrink-0 mt-0.5" />
          <p className="text-[10px] font-mono text-[#8B949E] leading-relaxed uppercase tracking-wider">
            {depositsDisabled 
              ? "Deposits are currently disabled for security maintenance. Withdrawal remains active."
              : "Deposited USDC enters the yield vault. You can withdraw available funds from the exit section."
            }
          </p>
        </div>
      </div>

      {/* Action Button */}
      <div className="mt-auto">
        <button
          onClick={handleDeposit}
          disabled={!canSubmitDeposit}
          className="ys-btn-primary min-h-14 w-full sm:min-h-16 sm:text-sm"
        >
          {depositsDisabled ? (
            'Deposits Paused'
          ) : depositError ? (
            'Check Deposit Amount'
          ) : amountExceedsCapacity ? (
            'Amount Exceeds Pilot Cap'
          ) : capReached ? (
            'Vault Cap Reached'
          ) : txState === 'approving' ? (
            <><Loader2 size={20} className="animate-spin" /> Authorizing Assets...</>
          ) : txState === 'depositing' ? (
            <><Loader2 size={20} className="animate-spin" /> Executing Inflow...</>
          ) : txState === 'success' ? (
            <><CheckCircle2 size={20} className="text-[#030605]" /> Transaction Complete</>
          ) : (
            <><ArrowDownToLine size={20} /> Deposit USDC</>
          )}
        </button>
      </div>
    </div>
  );
}
