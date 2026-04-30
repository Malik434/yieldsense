'use client';

import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits } from 'viem';
import { KEEPER_ADDRESS, KEEPER_ABI } from '@/lib/contracts';
import { LogOut, AlertTriangle, CheckCircle2, Loader2, Shield, Info } from 'lucide-react';

/**
 * WithdrawModule — full-balance withdrawal from the ERC-4626 vault.
 *
 * Performance fee note:
 *   The on-chain ERC-4626 withdraw() does not currently enforce a performance fee.
 *   A fee mechanism tied to an on-chain high-water mark will be introduced in the
 *   next protocol upgrade. Until then, withdrawals return the full vault balance.
 *   Do not display speculative fee deductions that do not reflect actual on-chain
 *   behaviour.
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
      <div className="cyber-card p-6 flex items-center justify-center min-h-[200px]">
        <p className="font-mono text-xs" style={{ color: '#334155' }}>
          Connect wallet to view exit options
        </p>
      </div>
    );
  }

  return (
    <div className="cyber-card p-6 flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <LogOut size={15} style={{ color: '#f59e0b' }} />
        <span className="neon-label" style={{ color: '#f59e0b' }}>EXIT FLOW — WITHDRAW</span>
      </div>

      {/* Balance display */}
      <div
        className="rounded-lg p-4"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)' }}
      >
        <p className="font-mono text-[10px] tracking-widest mb-1" style={{ color: '#475569' }}>
          WITHDRAWABLE BALANCE
        </p>
        <p className="font-mono font-bold text-2xl" style={{ color: '#e2e8f0' }}>
          {balanceNum.toFixed(6)}{' '}
          <span style={{ color: '#64748b', fontSize: 13 }}>USDC</span>
        </p>
        <p className="font-mono text-[9px] mt-1" style={{ color: '#334155' }}>
          Full vault position — from maxWithdraw()
        </p>
      </div>

      {/* Performance fee notice */}
      <div
        className="flex items-start gap-2 rounded-lg p-3"
        style={{ background: 'rgba(0,212,255,0.04)', border: '1px solid rgba(0,212,255,0.1)' }}
      >
        <Info size={12} style={{ color: '#00d4ff', flexShrink: 0, marginTop: 1 }} />
        <p className="font-mono text-[10px] leading-relaxed" style={{ color: '#64748b' }}>
          Performance fees will be enforced on-chain in the next protocol upgrade.
          Current withdrawals return the full balance with no fee deduction.
        </p>
      </div>

      {/* Confirmation warning */}
      {confirming && (
        <div
          className="flex items-center gap-2 rounded-lg p-3"
          style={{ background: 'rgba(255,68,102,0.06)', border: '1px solid rgba(255,68,102,0.2)' }}
        >
          <AlertTriangle size={13} style={{ color: '#ff4466' }} />
          <p className="font-mono text-xs" style={{ color: '#ff4466' }}>
            Confirm: this withdraws your full balance. Your strategy will stop executing.
          </p>
        </div>
      )}

      {/* Action button */}
      {success ? (
        <div
          className="flex items-center justify-center gap-2 py-3 rounded-lg"
          style={{ background: 'rgba(0,255,159,0.08)', border: '1px solid rgba(0,255,159,0.3)' }}
        >
          <CheckCircle2 size={16} style={{ color: '#00ff9f' }} />
          <span className="font-mono text-sm font-bold" style={{ color: '#00ff9f' }}>
            WITHDRAWAL COMPLETE
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            onClick={handleWithdraw}
            disabled={balanceNum === 0 || withdrawing}
            className="flex items-center justify-center gap-2 py-3 rounded-lg font-mono text-sm font-bold tracking-wider transition-all"
            style={{
              background: confirming
                ? 'rgba(255,68,102,0.15)'
                : balanceNum === 0
                ? 'rgba(255,255,255,0.03)'
                : 'rgba(245,158,11,0.08)',
              border: confirming
                ? '1px solid rgba(255,68,102,0.5)'
                : balanceNum === 0
                ? '1px solid rgba(255,255,255,0.06)'
                : '1px solid rgba(245,158,11,0.4)',
              color: confirming ? '#ff4466' : balanceNum === 0 ? '#334155' : '#f59e0b',
              cursor: balanceNum === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {withdrawing ? (
              <><Loader2 size={14} className="animate-spin" /> PROCESSING…</>
            ) : confirming ? (
              <><AlertTriangle size={14} /> CONFIRM WITHDRAWAL</>
            ) : (
              <><LogOut size={14} /> WITHDRAW ALL LIQUIDITY</>
            )}
          </button>
          {confirming && (
            <button
              onClick={() => setConfirming(false)}
              className="font-mono text-xs text-center transition-colors"
              style={{ color: '#334155' }}
              onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.color = '#64748b')}
              onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.color = '#334155')}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <Shield size={10} style={{ color: '#334155' }} />
        <p className="font-mono text-[10px]" style={{ color: '#334155' }}>
          Withdrawals execute atomically on-chain — no counterparty risk
        </p>
      </div>
    </div>
  );
}
