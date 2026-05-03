'use client';

import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits, parseUnits } from 'viem';
import { ASSET_ADDRESS, KEEPER_ADDRESS, ERC20_ABI, KEEPER_ABI } from '@/lib/contracts';
import { ShieldCheck, ArrowDownToLine, Unlock, Lock, Loader2, CheckCircle2 } from 'lucide-react';

/**
 * DepositModule
 *
 * Approval model:
 *   We approve exactly the deposit amount rather than type(uint256).max.
 *   An unlimited approval grants the vault permanent access to all user USDC
 *   regardless of how much they intend to deposit, creating unnecessary risk
 *   if the contract is ever exploited or replaced.
 *
 *   The trade-off is that each deposit requires a fresh approval if the user
 *   changes the amount. This is the correct security posture for an MVP.
 */
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
    // Legacy EOA fallback: only used when writeContractsAsync (EIP-5792 batch) is not
    // available (e.g. MetaMask without smart account support). Not called from UI directly.
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

  const paymasterUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL;

  const handleDeposit = async () => {
    if (!address || !actualAssetAddress || depositAmountParsed === ZERO) return;
    setTxState('depositing');
    try {
      // Step 1: ensure approval is current
      if (!isApprovedForAmount) {
        await handleApprove();
        // handleApprove resets state to 'idle'; caller must re-click to deposit.
        return;
      }
      // Step 2: deposit
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

      {/* Wallet balance */}
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

      {/* Amount input — shown first so approve/deposit can be amount-scoped */}
      <div className="flex flex-col gap-2">
        <label className="font-mono text-xs" style={{ color: '#64748b' }}>
          DEPOSIT AMOUNT (USDC)
        </label>
        <div className="flex gap-2">
          <input
            type="number"
            placeholder="0.00"
            value={depositAmount}
            onChange={e => setDepositAmount(e.target.value)}
            className="cyber-input flex-1"
            min="0"
          />
          <button
            onClick={() => setDepositAmount(parseFloat(walletBalance).toFixed(6))}
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

      {/* Approve step — only shown in the non-sponsored EOA fallback path when
          paymasterService is not configured and the user hasn't pre-approved yet. */}
      {!paymasterUrl && depositAmountParsed > ZERO && !isApprovedForAmount && (
        <div
          className="rounded-lg p-4 flex flex-col gap-3"
          style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.2)' }}
        >
          <div className="flex items-center gap-2">
            <Unlock size={14} style={{ color: '#a78bfa' }} />
            <p className="font-mono text-xs font-semibold" style={{ color: '#a78bfa' }}>
              STEP 1 — APPROVE {depositAmount} USDC
            </p>
          </div>
          <p className="text-xs" style={{ color: '#64748b' }}>
            Authorise the vault to spend exactly {depositAmount} USDC for this deposit.
          </p>
          <button
            onClick={handleApprove}
            disabled={isLoading}
            className="btn-purple flex items-center justify-center gap-2 w-full"
          >
            {txState === 'approving' ? (
              <><Loader2 size={14} className="animate-spin" /> APPROVING…</>
            ) : (
              <><Unlock size={14} /> APPROVE {depositAmount} USDC</>
            )}
          </button>
        </div>
      )}

      {/* Approved indicator — only relevant in the non-sponsored EOA path */}
      {!paymasterUrl && isApprovedForAmount && (
        <div className="flex items-center gap-2">
          <CheckCircle2 size={14} style={{ color: '#00ff9f' }} />
          <span className="font-mono text-xs" style={{ color: '#00ff9f' }}>
            APPROVED — ready to deposit
          </span>
        </div>
      )}

      {/* Deposit button — no prior approval needed when paymaster is active */}
      <button
        onClick={handleDeposit}
        disabled={isLoading || depositAmountParsed === ZERO || (!paymasterUrl && !isApprovedForAmount)}
        className="btn-primary flex items-center justify-center gap-2 w-full"
        style={{ opacity: depositAmountParsed > ZERO && (paymasterUrl || isApprovedForAmount) ? 1 : 0.4 }}
      >
        {txState === 'depositing' ? (
          <><Loader2 size={14} className="animate-spin" /> DEPOSITING…</>
        ) : txState === 'success' ? (
          <><CheckCircle2 size={14} /> DEPOSITED!</>
        ) : (
          <><ArrowDownToLine size={14} /> DEPOSIT TO VAULT</>
        )}
      </button>
    </div>
  );
}
