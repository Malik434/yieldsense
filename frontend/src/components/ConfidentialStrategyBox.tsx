'use client';

import { useState, useEffect } from 'react';
import { Lock, Shield, EyeOff, AlertTriangle, Info, CheckCircle2, Loader2 } from 'lucide-react';
import { useAccount, useSignTypedData } from 'wagmi';
import { KEEPER_ADDRESS } from '@/lib/contracts';
import { SecureSignatureAnimation } from './SecureSignatureAnimation';

interface StrategyParams {
  stopLossPrice: string;
  gridUpper: string;
  gridLower: string;
  rebalanceInterval: string;
}

const DEFAULT_PARAMS: StrategyParams = {
  stopLossPrice: '',
  gridUpper: '',
  gridLower: '',
  rebalanceInterval: '4',
};

// EIP-712 domain — must match /api/strategy/route.ts and processor.ts
const DOMAIN = {
  name: 'YieldSense',
  version: '1',
  chainId: 84532, // Base Sepolia
  verifyingContract: KEEPER_ADDRESS,
} as const;

const TYPES = {
  StrategyParams: [
    { name: 'stopLossPrice', type: 'string' },
    { name: 'gridUpper', type: 'string' },
    { name: 'gridLower', type: 'string' },
    { name: 'rebalanceInterval', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
  ],
} as const;

type CommitStatus = 'idle' | 'signing' | 'submitting' | 'success' | 'error';

export function ConfidentialStrategyBox() {
  const { address, isConnected } = useAccount();
  const [params, setParams] = useState<StrategyParams>(DEFAULT_PARAMS);
  const [commitStatus, setCommitStatus] = useState<CommitStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [showAnimation, setShowAnimation] = useState(false);

  const { signTypedDataAsync } = useSignTypedData();

  // Load previously committed params from localStorage as a UI convenience
  useEffect(() => {
    if (!address) return;
    const stored = localStorage.getItem(`ys_strategy_${address}`);
    if (stored) {
      try { setParams(JSON.parse(stored)); } catch { /* ignore */ }
    }
  }, [address]);

  const hasValues = !!(params.stopLossPrice || params.gridUpper || params.gridLower);
  const isBusy = commitStatus === 'signing' || commitStatus === 'submitting';

  const handleSave = async () => {
    if (!address || !hasValues || isBusy) return;
    setErrorMsg('');
    setShowAnimation(true);
  };

  const handleAnimationComplete = async () => {
    setShowAnimation(false);
    if (!address) return;

    setCommitStatus('signing');
    const timestamp = Math.floor(Date.now() / 1000);

    try {
      // Step 1: Sign the EIP-712 typed data with the user's wallet
      const message = {
        stopLossPrice: params.stopLossPrice || '0',
        gridUpper: params.gridUpper || '0',
        gridLower: params.gridLower || '0',
        rebalanceInterval: params.rebalanceInterval || '4',
        timestamp: BigInt(timestamp),
      };

      const signature = await signTypedDataAsync({
        domain: DOMAIN,
        types: TYPES,
        primaryType: 'StrategyParams',
        message,
      });

      setCommitStatus('submitting');

      // Step 2: POST signed params to the API relay so the Acurast processor can fetch them
      const res = await fetch('/api/strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stopLossPrice: Number(params.stopLossPrice) || 0,
          gridUpper: Number(params.gridUpper) || 0,
          gridLower: Number(params.gridLower) || 0,
          rebalanceInterval: Number(params.rebalanceInterval) || 4,
          signer: address,
          signature,
          timestamp,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `API returned ${res.status}`);
      }

      // Step 3: Persist to localStorage as a UI cache (never used by the processor)
      localStorage.setItem(`ys_strategy_${address}`, JSON.stringify(params));
      setCommitStatus('success');
    } catch (err: any) {
      setCommitStatus('error');
      setErrorMsg(err?.message ?? String(err));
    }
  };

  const handleChange = (field: keyof StrategyParams) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setParams(prev => ({ ...prev, [field]: e.target.value }));
    if (commitStatus === 'success') setCommitStatus('idle');
  };

  return (
    <>
      {showAnimation && <SecureSignatureAnimation onComplete={handleAnimationComplete} />}

      <div className="cyber-card-locked p-6 flex flex-col gap-5 h-full">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock size={16} style={{ color: '#a78bfa' }} />
            <span className="font-mono font-bold tracking-widest" style={{ fontSize: 11, color: '#a78bfa', letterSpacing: '0.15em' }}>
              CONFIDENTIAL STRATEGY
            </span>
          </div>
          <div className="flex items-center gap-2">
            {commitStatus === 'success' && (
              <span className="status-badge encrypted">
                <CheckCircle2 size={9} />
                TEE SECURED
              </span>
            )}
            <span className="status-badge encrypted">
              <EyeOff size={9} />
              PRIVATE
            </span>
          </div>
        </div>

        {/* Privacy notice */}
        <div className="rounded-lg p-3 flex items-start gap-2" style={{ background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.15)' }}>
          <Info size={13} style={{ color: '#a78bfa', flexShrink: 0, marginTop: 1 }} />
          <p className="font-mono text-xs leading-relaxed" style={{ color: '#94a3b8' }}>
            Parameters are signed with your wallet and relayed to the Acurast TEE.{' '}
            <span style={{ color: '#a78bfa' }}>
              They are never stored on-chain and are invisible to validators or MEV bots.
            </span>
          </p>
        </div>

        {!isConnected ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="font-mono text-xs text-center" style={{ color: '#334155' }}>
              Connect wallet to configure your confidential strategy
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 flex-1">
            {/* Stop Loss */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Lock size={11} style={{ color: '#a78bfa' }} />
                <label className="font-mono text-xs font-semibold" style={{ color: '#a78bfa' }}>
                  INVISIBLE STOP-LOSS PRICE
                </label>
                <span className="px-1.5 py-0.5 rounded font-mono text-[9px]" style={{ background: 'rgba(255,68,102,0.08)', color: '#ff4466', border: '1px solid rgba(255,68,102,0.2)' }}>
                  FRONT-RUN PROTECTED
                </span>
              </div>
              <input
                type="number"
                placeholder="e.g. 0.94 USDC"
                value={params.stopLossPrice}
                onChange={handleChange('stopLossPrice')}
                disabled={isBusy}
                className="cyber-input"
              />
              <p className="font-mono text-[10px]" style={{ color: '#334155' }}>
                Trigger price encrypted inside TEE — validators cannot see or front-run this
              </p>
            </div>

            {/* Grid Range */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Lock size={11} style={{ color: '#a78bfa' }} />
                <label className="font-mono text-xs font-semibold" style={{ color: '#a78bfa' }}>
                  CONFIDENTIAL GRID RANGE
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[10px]" style={{ color: '#64748b' }}>UPPER BOUND</span>
                  <input type="number" placeholder="e.g. 1.02" value={params.gridUpper} onChange={handleChange('gridUpper')} disabled={isBusy} className="cyber-input" />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[10px]" style={{ color: '#64748b' }}>LOWER BOUND</span>
                  <input type="number" placeholder="e.g. 0.96" value={params.gridLower} onChange={handleChange('gridLower')} disabled={isBusy} className="cyber-input" />
                </div>
              </div>
            </div>

            {/* Rebalance Interval */}
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-xs font-semibold" style={{ color: '#a78bfa' }}>
                REBALANCE INTERVAL (HOURS)
              </label>
              <div className="flex gap-2">
                {['1', '4', '8', '24'].map((v) => (
                  <button
                    key={v}
                    onClick={() => { setParams(p => ({ ...p, rebalanceInterval: v })); if (commitStatus === 'success') setCommitStatus('idle'); }}
                    disabled={isBusy}
                    className="flex-1 py-2 rounded-lg font-mono text-xs font-semibold transition-all"
                    style={{
                      background: params.rebalanceInterval === v ? 'rgba(139,92,246,0.2)' : 'rgba(0,0,0,0.3)',
                      border: params.rebalanceInterval === v ? '1px solid rgba(139,92,246,0.6)' : '1px solid rgba(255,255,255,0.06)',
                      color: params.rebalanceInterval === v ? '#a78bfa' : '#64748b',
                    }}
                  >
                    {v}h
                  </button>
                ))}
              </div>
            </div>

            {/* Error message */}
            {commitStatus === 'error' && (
              <div className="flex items-start gap-2 rounded-lg p-2" style={{ background: 'rgba(255,68,102,0.06)', border: '1px solid rgba(255,68,102,0.2)' }}>
                <AlertTriangle size={11} style={{ color: '#ff4466', flexShrink: 0, marginTop: 1 }} />
                <span className="font-mono text-[10px]" style={{ color: '#ff4466' }}>{errorMsg}</span>
              </div>
            )}

            {/* Save Button */}
            <button
              onClick={handleSave}
              disabled={!hasValues || isBusy}
              className="btn-purple flex items-center justify-center gap-2 w-full mt-auto"
            >
              {isBusy ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {commitStatus === 'signing' ? 'WAITING FOR WALLET...' : 'COMMITTING TO TEE...'}
                </>
              ) : commitStatus === 'success' ? (
                <>
                  <CheckCircle2 size={14} />
                  UPDATE SECURE STRATEGY
                </>
              ) : (
                <>
                  <Shield size={14} />
                  SIGN & COMMIT TO TEE
                </>
              )}
            </button>

            {commitStatus === 'success' && (
              <p className="font-mono text-[10px] text-center" style={{ color: '#00ff9f' }}>
                ✓ Strategy signed · Relayed to Acurast processor · Enforced silently
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
