'use client';

import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits } from 'viem';
import { KEEPER_ADDRESS, KEEPER_ABI } from '@/lib/contracts';
import { LogOut, AlertTriangle, CheckCircle2, TrendingUp, Loader2, Shield } from 'lucide-react';

export function WithdrawModule() {
  const { address, isConnected } = useAccount();
  const [confirming, setConfirming] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [success, setSuccess] = useState(false);

  const { data: userData, refetch } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'userData',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { writeContractAsync } = useWriteContract();

  const balance = userData ? (userData as any)[0] as bigint : BigInt(0);
  const initialDeposit = userData ? (userData as any)[1] as bigint : BigInt(0);

  const balanceNum = parseFloat(formatUnits(balance, 18));
  const depositNum = parseFloat(formatUnits(initialDeposit, 18));
  const profit = Math.max(balanceNum - depositNum, 0);
  const PERF_FEE_BPS = 0.10;
  const performanceFee = profit > 0 ? profit * PERF_FEE_BPS : 0;
  const netPayout = balanceNum - performanceFee;
  const hwmMet = balanceNum > depositNum;

  const handleWithdraw = async () => {
    if (!confirming) { setConfirming(true); return; }
    setWithdrawing(true);
    try {
      await writeContractAsync({
        address: KEEPER_ADDRESS,
        abi: KEEPER_ABI,
        functionName: 'withdraw',
        gas: BigInt(300000),
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LogOut size={15} style={{ color: '#f59e0b' }} />
          <span className="neon-label" style={{ color: '#f59e0b' }}>EXIT FLOW — WITHDRAW</span>
        </div>
        {hwmMet && (
          <span className="status-badge" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b' }}>
            <TrendingUp size={9} />
            HWM MET
          </span>
        )}
      </div>

      {/* Breakdown table */}
      <div
        className="rounded-lg overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.06)' }}
      >
        {[
          {
            label: 'GROSS BALANCE',
            value: balanceNum.toFixed(6),
            color: '#e2e8f0',
            sublabel: 'Your total vault position',
          },
          {
            label: 'INITIAL DEPOSIT',
            value: depositNum.toFixed(6),
            color: '#64748b',
            sublabel: 'High-water mark baseline',
          },
          {
            label: 'PROFIT',
            value: profit.toFixed(6),
            color: profit > 0 ? '#00ff9f' : '#64748b',
            sublabel: profit > 0 ? 'Acurast-harvested yield' : 'No profit yet',
          },
          {
            label: 'PERFORMANCE FEE (10%)',
            value: performanceFee > 0 ? `-${performanceFee.toFixed(6)}` : '0.000000',
            color: performanceFee > 0 ? '#ff4466' : '#334155',
            sublabel: performanceFee > 0 ? 'Applied only on profit above HWM' : 'HWM not met — no fee',
          },
        ].map(({ label, value, color, sublabel }, i) => (
          <div
            key={label}
            className="flex items-center justify-between px-4 py-3"
            style={{
              borderBottom: i < 3 ? '1px solid rgba(255,255,255,0.04)' : 'none',
              background: i % 2 === 0 ? 'rgba(0,0,0,0.2)' : 'transparent',
            }}
          >
            <div>
              <p className="font-mono text-[10px] tracking-widest" style={{ color: '#475569' }}>{label}</p>
              <p className="font-mono text-[9px] mt-0.5" style={{ color: '#334155' }}>{sublabel}</p>
            </div>
            <span className="font-mono font-semibold text-sm" style={{ color }}>{value}</span>
          </div>
        ))}

        {/* Net payout row */}
        <div
          className="flex items-center justify-between px-4 py-4"
          style={{
            background: 'rgba(0,255,159,0.04)',
            borderTop: '1px solid rgba(0,255,159,0.15)',
          }}
        >
          <div>
            <p className="font-mono text-xs font-bold tracking-widest" style={{ color: '#00ff9f' }}>
              NET PAYOUT
            </p>
            <p className="font-mono text-[9px] mt-0.5" style={{ color: '#334155' }}>
              Amount transferred to your wallet
            </p>
          </div>
          <span
            className="font-mono font-bold text-xl"
            style={{ color: '#00ff9f', textShadow: '0 0 16px rgba(0,255,159,0.4)' }}
          >
            {netPayout.toFixed(6)}
          </span>
        </div>
      </div>

      {/* HWM explanation */}
      {!hwmMet && (
        <div
          className="flex items-start gap-2 rounded-lg p-3"
          style={{ background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.15)' }}
        >
          <AlertTriangle size={13} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
          <p className="font-mono text-xs" style={{ color: '#78716c' }}>
            High-Water Mark not yet met. No performance fee will be charged on this withdrawal.
            The 10% fee only applies when your balance exceeds your initial deposit.
          </p>
        </div>
      )}

      {/* Withdraw button */}
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
          {confirming && (
            <div
              className="flex items-center gap-2 rounded-lg p-3"
              style={{ background: 'rgba(255,68,102,0.06)', border: '1px solid rgba(255,68,102,0.2)' }}
            >
              <AlertTriangle size={13} style={{ color: '#ff4466' }} />
              <p className="font-mono text-xs" style={{ color: '#ff4466' }}>
                Confirm: This will withdraw all liquidity from the vault. Your strategy will be closed.
              </p>
            </div>
          )}
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
              <><Loader2 size={14} className="animate-spin" /> PROCESSING...</>
            ) : confirming ? (
              <><AlertTriangle size={14} /> CONFIRM WITHDRAWAL</>
            ) : (
              <><LogOut size={14} /> WITHDRAW ALL LIQUIDITY</>
            )}
          </button>
          {confirming && (
            <button
              onClick={() => setConfirming(false)}
              className="font-mono text-xs text-center transition-all"
              style={{ color: '#334155' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = '#64748b')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = '#334155')}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Shield note */}
      <div className="flex items-center gap-1.5">
        <Shield size={10} style={{ color: '#334155' }} />
        <p className="font-mono text-[10px]" style={{ color: '#334155' }}>
          Withdrawals are processed atomically on-chain — no counterparty risk
        </p>
      </div>
    </div>
  );
}
