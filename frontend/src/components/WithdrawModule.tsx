'use client';

import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits } from 'viem';
import { KEEPER_ADDRESS, KEEPER_ABI } from '@/lib/contracts';
import { LogOut, AlertTriangle, CheckCircle2, Loader2, Shield, Info } from 'lucide-react';

/**
 * WithdrawModule — full-balance withdrawal from the ERC-4626 vault.
 */
export function WithdrawModule() {
  const { address, isConnected } = useAccount();
  const [confirming, setConfirming] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [success, setSuccess] = useState(false);

  const { data: maxWithdrawRaw, refetch } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'maxWithdraw',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { writeContractAsync } = useWriteContract();

  const balance = maxWithdrawRaw ? (maxWithdrawRaw as bigint) : BigInt(0);
  const balanceNum = parseFloat(formatUnits(balance, 6));

  const handleWithdraw = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setWithdrawing(true);
    try {
      await writeContractAsync({
        address: KEEPER_ADDRESS,
        abi: KEEPER_ABI,
        functionName: 'withdraw',
        args: [balance, address as `0x${string}`, address as `0x${string}`],
      });
      setSuccess(true);
      setConfirming(false);
      await refetch();
    } catch (e) {
      console.error(e);
      setConfirming(false);
    } finally {
      setWithdrawing(false);
    }
  };

  if (!isConnected) {
    return (
      <div className="ys-card p-12 flex items-center justify-center min-h-[300px]">
        <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">
          Connect wallet to view exit options
        </p>
      </div>
    );
  }

  return (
    <div className="ys-card p-12 flex flex-col gap-10 relative overflow-hidden group">
      <div className="absolute top-0 right-0 p-12 bg-[#FF4466]/[0.02] rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      
      <div className="flex items-center justify-between relative z-10">
        <div className="flex items-center gap-4">
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
            <LogOut size={20} className="text-[#FF4466]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Liquidity Exit</p>
            <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">Vault Withdrawal</h3>
          </div>
        </div>
        <div className="ys-badge bg-white/5 border-white/10 text-[#484F58] flex items-center gap-2">
          <Shield size={12} />
          ATOMIC
        </div>
      </div>

      {/* Balance display */}
      <div className="rounded-3xl p-8 bg-white/[0.02] border border-white/[0.04] relative z-10">
        <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] mb-3">Withdrawable Position</p>
        <div className="flex items-baseline gap-3">
          <span className="text-5xl font-heading font-bold text-[#F5F7FA] tracking-tight">
            {balanceNum.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 })}
          </span>
          <span className="text-xl font-heading font-bold text-[#484F58]">USDC</span>
        </div>
        <p className="text-[9px] font-mono text-[#484F58] mt-4 uppercase tracking-widest">
          Full vault position — Verified on-chain
        </p>
      </div>

      {/* Performance fee notice */}
      <div className="flex items-start gap-4 p-5 rounded-2xl bg-[#00FFA3]/[0.03] border border-[#00FFA3]/10 relative z-10">
        <Info size={16} className="text-[#00FFA3] flex-shrink-0 mt-0.5" />
        <p className="text-[10px] font-mono text-[#8B949E] leading-relaxed uppercase tracking-wider">
          Performance fees will be enforced on-chain in the next protocol upgrade. <br />
          Current withdrawals return the <span className="text-[#F5F7FA]">full balance</span> with zero fee deduction.
        </p>
      </div>

      {/* Confirmation warning */}
      {confirming && (
        <div className="flex items-center gap-4 p-5 rounded-2xl bg-[#FF4466]/[0.05] border border-[#FF4466]/20 animate-fade-in relative z-10">
          <AlertTriangle size={18} className="text-[#FF4466] flex-shrink-0" />
          <p className="text-xs font-mono font-bold text-[#FF4466] uppercase tracking-wider">
            Alert: Strategy execution will terminate upon settlement of this withdrawal.
          </p>
        </div>
      )}

      {/* Action button */}
      <div className="flex flex-col gap-4 relative z-10 mt-auto">
        {success ? (
          <div className="flex items-center justify-center gap-3 py-5 rounded-2xl bg-[#00FFA3]/10 border border-[#00FFA3]/30 animate-fade-in">
            <CheckCircle2 size={20} className="text-[#00FFA3]" />
            <span className="text-[10px] font-mono font-bold text-[#00FFA3] uppercase tracking-widest">
              Withdrawal Complete
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <button
              onClick={handleWithdraw}
              disabled={balanceNum === 0 || withdrawing}
              className={`
                ys-btn-primary w-full h-16 text-sm relative group overflow-hidden
                ${confirming ? 'bg-[#FF4466] border-[#FF4466]/40' : balanceNum === 0 ? 'opacity-30 grayscale pointer-events-none' : 'bg-[#1C212E] hover:bg-[#252B3A] border-white/[0.05] hover:border-white/[0.1]'}
              `}
            >
              <div className="relative flex items-center justify-center gap-3">
                {withdrawing ? (
                  <><Loader2 size={20} className="animate-spin" /> Processing Settlement...</>
                ) : confirming ? (
                  <><AlertTriangle size={20} className="animate-pulse" /> Confirm Full Exit</>
                ) : (
                  <><LogOut size={20} className="group-hover:translate-x-1 transition-transform" /> Initialize Exit Flow</>
                )}
              </div>
            </button>
            
            {confirming && (
              <button
                onClick={() => setConfirming(false)}
                className="text-[10px] font-mono font-bold text-[#484F58] hover:text-[#8B949E] transition-colors uppercase tracking-[0.3em] py-3"
              >
                Cancel Settlement
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 relative z-10 pt-6 border-t border-white/[0.03]">
        <Shield size={14} className="text-[#484F58]" />
        <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">
          Atomic on-chain execution · Zero counterparty risk
        </p>
      </div>
    </div>
  );
}
