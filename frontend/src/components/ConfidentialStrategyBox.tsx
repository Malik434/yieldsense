'use client';

import { useState, useEffect } from 'react';
import { Lock, Shield, EyeOff, AlertTriangle, CheckCircle2, Loader2, Cpu, Fingerprint, TrendingUp, TrendingDown, Target, SlidersHorizontal, MousePointer2, RefreshCcw } from 'lucide-react';
import { useAccount, useSignTypedData } from 'wagmi';
import { KEEPER_ADDRESS } from '@/lib/contracts';
import { SecureSignatureAnimation } from './SecureSignatureAnimation';

interface StrategyParams {
  stopLossPrice: string;
  gridUpper: string;
  gridLower: string;
  rebalanceInterval: string;
  maxSlippage: number;
  autoReinvest: boolean;
}

const DEFAULT_PARAMS: StrategyParams = {
  stopLossPrice: '',
  gridUpper: '',
  gridLower: '',
  rebalanceInterval: '4',
  maxSlippage: 0.5,
  autoReinvest: true,
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
    { name: 'maxSlippage', type: 'string' },
    { name: 'autoReinvest', type: 'bool' },
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
      try { 
        const parsed = JSON.parse(stored);
        setParams(prev => ({ ...prev, ...parsed })); 
      } catch { /* ignore */ }
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
        maxSlippage: params.maxSlippage.toString(),
        autoReinvest: params.autoReinvest,
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
          ...params,
          maxSlippage: Number(params.maxSlippage),
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
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setParams(prev => ({ ...prev, [field]: val }));
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

      <div className="ys-card p-12 flex flex-col gap-10 h-full relative group">
        <div className="absolute top-0 right-0 p-12 bg-[#00FFA3]/[0.02] rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />
        
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-4">
            <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
              <SlidersHorizontal size={20} className="text-[#00FFA3]" />
            </div>
            <div>
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Confidential Logic</p>
              <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">Strategy Parameters</h3>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <span className="text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Auto-Compound</span>
              <button 
                onClick={() => setParams(p => ({ ...p, autoReinvest: !p.autoReinvest }))}
                className={`w-10 h-5 rounded-full transition-all relative ${params.autoReinvest ? 'bg-[#00FFA3]' : 'bg-white/10'}`}
              >
                <div className={`absolute top-1 w-3 h-3 rounded-full bg-black transition-all ${params.autoReinvest ? 'left-6' : 'left-1'}`} />
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-8 relative z-10">
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
            <div className="relative">
              <input
                type="number"
                placeholder="0.00 USDC"
                value={params.stopLossPrice}
                onChange={handleChange('stopLossPrice')}
                disabled={isBusy}
                className="ys-input w-full pr-16 text-xl"
              />
              <div className="absolute right-5 top-1/2 -translate-y-1/2">
                <Target size={16} className="text-[#484F58]" />
              </div>
            </div>
          </div>

          {/* Max Slippage Slider */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] ml-1">
                Maximum Slippage
              </label>
              <span className="text-xs font-heading font-bold text-[#C2E812]">{params.maxSlippage}%</span>
            </div>
            <div className="relative h-6 flex items-center">
              <div className="absolute w-full h-1 bg-white/5 rounded-full" />
              <div className="absolute h-1 bg-[#C2E812]/40 rounded-full" style={{ width: `${(params.maxSlippage / 2) * 100}%` }} />
              <input 
                type="range" 
                min="0.1" 
                max="2.0" 
                step="0.1" 
                value={params.maxSlippage} 
                onChange={e => setParams(p => ({ ...p, maxSlippage: parseFloat(e.target.value) }))}
                className="absolute w-full h-1 bg-transparent appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-[#C2E812] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-lg"
              />
            </div>
          </div>

          {/* Grid Range */}
          <div className="flex flex-col gap-3">
            <label className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] ml-1">
              Optimization Range
            </label>
            <div className="grid grid-cols-2 gap-6">
              <div className="flex flex-col gap-2">
                <span className="text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Upper Limit</span>
                <input type="number" placeholder="1.00" value={params.gridUpper} onChange={handleChange('gridUpper')} disabled={isBusy} className="ys-input w-full text-base" />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-[9px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Lower Limit</span>
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

        {/* Action button */}
        <div className="mt-auto relative z-10">
          <button
            onClick={handleSave}
            disabled={!hasValues || isBusy}
            className={`ys-btn-primary w-full h-16 text-sm relative group overflow-hidden transition-all duration-500 ${commitStatus === 'success' ? 'bg-[#00FFA3] text-[#030605]' : ''}`}
          >
            <div className="relative flex items-center justify-center gap-3">
              {isBusy ? (
                <><Loader2 size={20} className="animate-spin" /> Sealing Strategy...</>
              ) : commitStatus === 'success' ? (
                <><CheckCircle2 size={20} /> Strategy Committed</>
              ) : (
                <><Fingerprint size={20} /> Sign & Commit to TEE</>
              )}
            </div>
          </button>
          
          {commitStatus === 'error' && (
            <p className="text-[9px] font-mono text-[#FF4466] mt-4 text-center uppercase tracking-widest">
              {errorMsg || 'Commitment Failed. Verify Network.'}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
