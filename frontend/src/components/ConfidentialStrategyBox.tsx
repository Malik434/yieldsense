'use client';

import { useState, useEffect } from 'react';
import { Lock, Shield, EyeOff, AlertTriangle, CheckCircle2, Loader2, Cpu, Fingerprint, TrendingUp, TrendingDown, Target, SlidersHorizontal } from 'lucide-react';
import { useAccount, useSignTypedData, useReadContract } from 'wagmi';
import { KEEPER_ADDRESS, KEEPER_ABI } from '@/lib/contracts';
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

const DOMAIN = {
  name: 'YieldSense',
  version: '1',
  chainId: 84532, 
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

      const res = await fetch('https://yieldsense.netlify.app/.netlify/functions/update-strategy', {
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

      localStorage.setItem(`ys_strategy_${address}`, JSON.stringify(params));
      setCommitStatus('success');
      setTimeout(() => setCommitStatus('idle'), 4000);
    } catch (err: any) {
      setCommitStatus('error');
      setErrorMsg(err?.message ?? String(err));
    }
  };

  const handleChange = (field: keyof StrategyParams) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setParams(prev => ({ ...prev, [field]: e.target.value }));
    if (commitStatus === 'success') setCommitStatus('idle');
  };

  if (!isConnected) {
    return (
      <div className="ys-card p-12 flex flex-col items-center justify-center text-center gap-6 h-full">
        <div className="w-20 h-20 rounded-3xl bg-white/5 border border-white/10 flex items-center justify-center opacity-40">
          <Lock size={32} className="text-[#484F58]" />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-heading font-bold text-[#F5F7FA] uppercase tracking-widest">Vault Entry</h3>
          <p className="text-xs font-mono text-[#8B949E] max-w-[240px] mx-auto leading-relaxed uppercase tracking-widest">
            Synchronize cryptographic identity to initialize strategy engine.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {showAnimation && <SecureSignatureAnimation onComplete={handleAnimationComplete} />}

      <div className="ys-card p-12 flex flex-col gap-10 h-full relative">
        <div className="absolute top-0 right-0 p-12 bg-[#00FFA3]/[0.02] rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
        
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <SlidersHorizontal size={20} className="text-[#00FFA3]" />
            </div>
            <div>
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Confidential Logic</p>
              <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">Strategy Parameters</h3>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="px-3 py-1.5 rounded-lg bg-[#00FFA3]/5 border border-[#00FFA3]/10 flex items-center gap-2">
              <Cpu size={12} className="text-[#00FFA3] animate-pulse" />
              <span className="text-[10px] font-mono font-bold text-[#00FFA3] tracking-widest">TEE Active</span>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          {/* Stop Loss Price */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] ml-1">
                Protected Stop-Loss
              </label>
              <div className="flex items-center gap-2">
                <Shield size={10} className="text-[#FF4466]/60" />
                <span className="text-[9px] font-mono font-bold text-[#FF4466]/80 uppercase tracking-widest">Shielded</span>
              </div>
            </div>
            <div className="relative group/input">
              <input
                type="number"
                placeholder="0.00 USDC"
                value={params.stopLossPrice}
                onChange={handleChange('stopLossPrice')}
                disabled={isBusy}
                className="ys-input w-full pr-16 text-xl"
              />
              <div className="absolute right-5 top-1/2 -translate-y-1/2">
                <Target size={16} className="text-[#484F58] group-focus-within:text-[#00FFA3] transition-colors" />
              </div>
            </div>
          </div>

          {/* Grid Range */}
          <div className="flex flex-col gap-3">
            <label className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] ml-1">
              Optimization Range
            </label>
            <div className="grid grid-cols-2 gap-6">
              <div className="flex flex-col gap-2">
                <span className="text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Upper</span>
                <input type="number" placeholder="1.00" value={params.gridUpper} onChange={handleChange('gridUpper')} disabled={isBusy} className="ys-input w-full text-base" />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Lower</span>
                <input type="number" placeholder="0.80" value={params.gridLower} onChange={handleChange('gridLower')} disabled={isBusy} className="ys-input w-full text-base" />
              </div>
            </div>
          </div>

          {/* Rebalance Interval */}
          <div className="flex flex-col gap-3">
            <label className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] ml-1">
              Execution Heartbeat
            </label>
            <div className="flex gap-2">
              {['1', '4', '8', '24'].map((v) => (
                <button
                  key={v}
                  onClick={() => { setParams(p => ({ ...p, rebalanceInterval: v })); if (commitStatus === 'success') setCommitStatus('idle'); }}
                  disabled={isBusy}
                  className={`
                    flex-1 h-12 rounded-2xl font-heading text-[10px] font-bold transition-all duration-300
                    ${params.rebalanceInterval === v 
                      ? 'bg-[#C2E812] text-[#030605] shadow-lg shadow-[#C2E812]/10' 
                      : 'bg-white/5 border border-white/5 text-[#484F58] hover:text-[#8B949E]'}
                    border-none uppercase tracking-widest
                  `}
                >
                  {v}H
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Security Footer */}
        <div className="rounded-2xl p-6 bg-white/[0.02] border border-white/[0.04] mt-auto">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[10px] font-mono font-bold text-[#484F58] tracking-[0.2em] uppercase">Security Metadata</span>
            <Fingerprint size={12} className="text-[#C2E812]/40" />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-[#8B949E] uppercase tracking-wider">EIP-712</span>
              <span className="text-[10px] font-mono font-bold text-[#F5F7FA]">YieldSense v1</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-[#8B949E] uppercase tracking-wider">Nonce</span>
              <span className="text-[10px] font-mono font-bold text-[#C2E812]">Authorized</span>
            </div>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={!hasValues || isBusy}
          className="ys-btn-primary w-full h-16 text-sm"
        >
          {isBusy ? (
            <div className="flex items-center justify-center gap-3">
              <Loader2 size={20} className="animate-spin" />
              <span className="font-heading font-bold uppercase tracking-widest">Sealing Strategy...</span>
            </div>
          ) : commitStatus === 'success' ? (
            <div className="flex items-center justify-center gap-3">
              <CheckCircle2 size={20} className="text-[#030605]" />
              <span className="font-heading font-bold uppercase tracking-widest">Strategy Sealed</span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-3">
              <Shield size={20} />
              <span className="font-heading font-bold uppercase tracking-widest">Sign & Commit to TEE</span>
            </div>
          )}
        </button>
      </div>
    </>
  );
}
