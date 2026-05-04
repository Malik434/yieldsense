'use client';

import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits, parseUnits } from 'viem';
import { ASSET_ADDRESS, KEEPER_ADDRESS, ERC20_ABI, KEEPER_ABI } from '@/lib/contracts';
import { ShieldCheck, ArrowDownToLine, Unlock, Lock, Loader2, CheckCircle2, Wallet, Info } from 'lucide-react';

export function DepositModule() {
  const { address, isConnected } = useAccount();
  const [depositAmount, setDepositAmount] = useState('');
  const [txState, setTxState] = useState<'idle' | 'approving' | 'depositing' | 'success'>('idle');

  const { data: dynamicAssetAddress } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'asset',
  });
  const actualAssetAddress = (ASSET_ADDRESS || dynamicAssetAddress) as `0x${string}` | undefined;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: actualAssetAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address && actualAssetAddress ? [address, KEEPER_ADDRESS] : undefined,
    query: { enabled: !!address && !!actualAssetAddress },
  });

  const { data: assetBalance } = useReadContract({
    address: actualAssetAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!actualAssetAddress },
  });

  const { writeContractAsync } = useWriteContract();

  const ZERO = BigInt(0);

  const depositAmountParsed =
    depositAmount && parseFloat(depositAmount) > 0
      ? parseUnits(depositAmount, 6)
      : ZERO;

  const currentAllowance = allowance ? (allowance as bigint) : ZERO;
  const isApprovedForAmount = depositAmountParsed > ZERO && currentAllowance >= depositAmountParsed;

  const walletBalance = assetBalance ? formatUnits(assetBalance as bigint, 6) : '0';
  const isLoading = txState === 'approving' || txState === 'depositing';

  const handleApprove = async () => {
    if (!actualAssetAddress || depositAmountParsed === ZERO) return;
    setTxState('approving');
    try {
      await writeContractAsync({
        address: actualAssetAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [KEEPER_ADDRESS, depositAmountParsed],
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
      <div className="ys-card p-12 flex flex-col items-center justify-center text-center gap-6 min-h-[350px]">
        <div className="w-20 h-20 rounded-3xl bg-white/5 border border-white/10 flex items-center justify-center">
          <Wallet size={32} className="text-[#484F58]" />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-heading font-bold text-[#F5F7FA] uppercase tracking-widest">Connect Wallet</h3>
          <p className="text-xs font-mono text-[#8B949E] max-w-[240px] mx-auto leading-relaxed uppercase tracking-widest">
            Synchronize your asset account to initialize vault allocation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ys-card p-12 flex flex-col gap-10 h-full relative">
      <div className="absolute top-0 right-0 p-12 bg-[#C2E812]/[0.02] rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
            <ArrowDownToLine size={20} className="text-[#C2E812]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Capital Inflow</p>
            <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">Asset Allocation</h3>
          </div>
        </div>
        <div className="flex items-center gap-2 px-0 py-1.5 text-[#00FFA3]">
          <ShieldCheck size={14} />
          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.3em]">Secured</span>
        </div>
      </div>

      <div className="space-y-6">
        {/* Wallet Balance */}
        <div className="rounded-3xl p-6 bg-white/[0.02] border border-white/[0.04]">
          <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] mb-2">Available Balance</p>
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-heading font-bold text-[#F5F7FA]">
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
          <div className="flex gap-4">
            <div className="relative flex-1">
              <input
                type="number"
                placeholder="0.00"
                value={depositAmount}
                onChange={e => setDepositAmount(e.target.value)}
                className="ys-input w-full pr-16 text-2xl"
              />
              <div className="absolute right-5 top-1/2 -translate-y-1/2 text-xs font-mono font-bold text-[#484F58]">USDC</div>
            </div>
            <button
              onClick={() => setDepositAmount(parseFloat(walletBalance).toFixed(6))}
              className="px-6 rounded-2xl bg-white/5 border border-white/10 font-heading font-bold text-xs uppercase tracking-widest hover:bg-white/10 transition-all"
            >
              Max
            </button>
          </div>
        </div>
      </div>

      {/* Info Notice */}
      <div className="flex items-start gap-4 p-5 rounded-2xl bg-[#C2E812]/[0.03] border border-[#C2E812]/10">
        <Info size={16} className="text-[#C2E812] flex-shrink-0 mt-0.5" />
        <p className="text-[10px] font-mono text-[#8B949E] leading-relaxed uppercase tracking-wider">
          Allocation will be processed through the YieldSense autonomous engine. Funds remain accessible via the exit flow at any time.
        </p>
      </div>

      {/* Action Button */}
      <div className="mt-auto">
        <button
          onClick={handleDeposit}
          disabled={isLoading || depositAmountParsed === ZERO}
          className="ys-btn-primary w-full h-16 text-sm"
        >
          {txState === 'approving' ? (
            <><Loader2 size={20} className="animate-spin" /> Authorizing Assets...</>
          ) : txState === 'depositing' ? (
            <><Loader2 size={20} className="animate-spin" /> Executing Inflow...</>
          ) : txState === 'success' ? (
            <><CheckCircle2 size={20} className="text-[#030605]" /> Transaction Complete</>
          ) : (
            <><ArrowDownToLine size={20} /> Confirm Allocation</>
          )}
        </button>
      </div>
    </div>
  );
}
