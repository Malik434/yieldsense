'use client';

import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits, parseUnits, maxUint256 } from 'viem';
import { ASSET_ADDRESS, KEEPER_ADDRESS, ERC20_ABI, KEEPER_ABI } from '@/lib/contracts';
import { ShieldCheck, ArrowDownToLine, Unlock, Lock, Loader2, CheckCircle2 } from 'lucide-react';

export function DepositModule() {
  const { address, isConnected } = useAccount();
  const [depositAmount, setDepositAmount] = useState('');
  const [txState, setTxState] = useState<'idle' | 'approving' | 'depositing' | 'success'>('idle');

  const { data: dynamicAssetAddress } = useReadContract({
    address: KEEPER_ADDRESS,
    abi: KEEPER_ABI,
    functionName: 'asset',
  });
  const actualAssetAddress = ASSET_ADDRESS || (dynamicAssetAddress as `0x${string}`);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: actualAssetAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, KEEPER_ADDRESS] : undefined,
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

  const handleApprove = async () => {
    setTxState('approving');
    try {
      await writeContractAsync({
        address: actualAssetAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [KEEPER_ADDRESS, maxUint256],
        gas: BigInt(100000),
      });
      await refetchAllowance();
      setTxState('idle');
    } catch (e) {
      console.error(e);
      setTxState('idle');
    }
  };

  const handleDeposit = async () => {
    if (!depositAmount || parseFloat(depositAmount) <= 0) return;
    setTxState('depositing');
    try {
      await writeContractAsync({
        address: KEEPER_ADDRESS,
        abi: KEEPER_ABI,
        functionName: 'deposit',
        args: [parseUnits(depositAmount, 6)],
        gas: BigInt(300000),
      });
      setTxState('success');
      setDepositAmount('');
      setTimeout(() => setTxState('idle'), 3000);
    } catch (e) {
      console.error(e);
      setTxState('idle');
    }
  };

  const isApproved = allowance && (allowance as bigint) > BigInt(0);
  const walletBalance = assetBalance ? formatUnits(assetBalance as bigint, 6) : '0';
  const isLoading = txState === 'approving' || txState === 'depositing';

  if (!isConnected) {
    return (
      <div className="cyber-card p-6 flex flex-col items-center justify-center text-center gap-4 min-h-[280px]">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(0,255,159,0.06)', border: '1px solid rgba(0,255,159,0.2)' }}
        >
          <Lock size={24} style={{ color: '#00ff9f', opacity: 0.6 }} />
        </div>
        <div>
          <p className="font-mono text-sm font-semibold" style={{ color: '#e2e8f0' }}>
            WALLET NOT CONNECTED
          </p>
          <p className="text-xs mt-1" style={{ color: '#64748b' }}>
            Connect your wallet to deposit into the vault
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="cyber-card p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowDownToLine size={16} style={{ color: '#00ff9f' }} />
          <span className="neon-label">DEPOSIT MODULE</span>
        </div>
        <span className="status-badge verified">
          <ShieldCheck size={10} />
          VAULT ACTIVE
        </span>
      </div>

      {/* Balance */}
      <div
        className="rounded-lg p-4"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)' }}
      >
        <p className="text-xs font-mono" style={{ color: '#64748b' }}>WALLET BALANCE</p>
        <p className="font-mono font-bold text-xl mt-1" style={{ color: '#e2e8f0' }}>
          {parseFloat(walletBalance).toFixed(4)}{' '}
          <span style={{ color: '#64748b', fontSize: 13 }}>USDC</span>
        </p>
      </div>

      {/* Approval step */}
      {!isApproved ? (
        <div
          className="rounded-lg p-4 flex flex-col gap-3"
          style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.2)' }}
        >
          <div className="flex items-center gap-2">
            <Unlock size={14} style={{ color: '#a78bfa' }} />
            <p className="font-mono text-xs font-semibold" style={{ color: '#a78bfa' }}>
              STEP 1 — GRANT VAULT ACCESS
            </p>
          </div>
          <p className="text-xs" style={{ color: '#64748b' }}>
            Authorize the YieldSense Keeper to manage your assets. One-time approval.
          </p>
          <button
            onClick={handleApprove}
            disabled={isLoading}
            className="btn-purple flex items-center justify-center gap-2 w-full"
          >
            {txState === 'approving' ? (
              <><Loader2 size={14} className="animate-spin" /> APPROVING...</>
            ) : (
              <><Unlock size={14} /> GRANT ACCESS</>
            )}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} style={{ color: '#00ff9f' }} />
            <span className="font-mono text-xs" style={{ color: '#00ff9f' }}>
              STEP 1 — ACCESS GRANTED ✓
            </span>
          </div>

          {/* Amount Input */}
          <div className="flex flex-col gap-2">
            <label className="font-mono text-xs" style={{ color: '#64748b' }}>
              DEPOSIT AMOUNT (USDC)
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="0.00"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                className="cyber-input flex-1"
                min="0"
              />
              <button
                onClick={() => setDepositAmount(parseFloat(walletBalance).toFixed(4))}
                className="px-3 rounded-lg font-mono text-xs font-semibold transition-all"
                style={{
                  background: 'rgba(0,255,159,0.06)',
                  border: '1px solid rgba(0,255,159,0.2)',
                  color: '#00ff9f',
                  whiteSpace: 'nowrap',
                }}
              >
                MAX
              </button>
            </div>
          </div>

          <button
            onClick={handleDeposit}
            disabled={isLoading || !depositAmount || parseFloat(depositAmount) <= 0}
            className="btn-primary flex items-center justify-center gap-2 w-full"
          >
            {txState === 'depositing' ? (
              <><Loader2 size={14} className="animate-spin" /> DEPOSITING...</>
            ) : txState === 'success' ? (
              <><CheckCircle2 size={14} /> DEPOSITED!</>
            ) : (
              <><ArrowDownToLine size={14} /> DEPOSIT TO VAULT</>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
