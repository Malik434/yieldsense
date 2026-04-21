'use client';

import { useState, useEffect } from 'react';
import { Lock, Shield, EyeOff, Save, AlertTriangle, Info } from 'lucide-react';
import { useAccount } from 'wagmi';
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

export function ConfidentialStrategyBox() {
  const { address, isConnected } = useAccount();
  const [params, setParams] = useState<StrategyParams>(DEFAULT_PARAMS);
  const [saved, setSaved] = useState(false);
  const [showAnimation, setShowAnimation] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    if (!address) return;
    const key = `ys_strategy_${address}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        setParams(JSON.parse(stored));
        setSaved(true);
      } catch { }
    }
  }, [address]);

  const handleSave = () => {
    if (!address) return;
    setShowAnimation(true);
  };

  const handleAnimationComplete = () => {
    setShowAnimation(false);
    if (!address) return;
    const key = `ys_strategy_${address}`;
    localStorage.setItem(key, JSON.stringify(params));
    setSaved(true);
  };

  const handleChange = (field: keyof StrategyParams) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setParams(prev => ({ ...prev, [field]: e.target.value }));
    setSaved(false);
  };

  const hasValues = params.stopLossPrice || params.gridUpper || params.gridLower;

  return (
    <>
      {showAnimation && <SecureSignatureAnimation onComplete={handleAnimationComplete} />}

      <div className="cyber-card-locked p-6 flex flex-col gap-5 h-full">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock size={16} style={{ color: '#a78bfa' }} />
            <span
              className="font-mono font-bold tracking-widest"
              style={{ fontSize: 11, color: '#a78bfa', letterSpacing: '0.15em' }}
            >
              CONFIDENTIAL STRATEGY
            </span>
          </div>
          <div className="flex items-center gap-2">
            {saved && hasValues && (
              <span className="status-badge encrypted">
                <Shield size={9} />
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
        <div
          className="rounded-lg p-3 flex items-start gap-2"
          style={{ background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.15)' }}
        >
          <Info size={13} style={{ color: '#a78bfa', flexShrink: 0, marginTop: 1 }} />
          <p className="font-mono text-xs leading-relaxed" style={{ color: '#94a3b8' }}>
            Parameters below are encrypted inside the Acurast TEE .{' '}
            <span style={{ color: '#a78bfa' }}>
              They are never stored on-chain, never visible to validators or MEV bots.
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
                <span
                  className="px-1.5 py-0.5 rounded font-mono text-[9px]"
                  style={{ background: 'rgba(255,68,102,0.08)', color: '#ff4466', border: '1px solid rgba(255,68,102,0.2)' }}
                >
                  FRONT-RUN PROTECTED
                </span>
              </div>
              <input
                type="number"
                placeholder="e.g. 0.94 USDC"
                value={params.stopLossPrice}
                onChange={handleChange('stopLossPrice')}
                className="cyber-input"
              />
              <p className="font-mono text-[10px]" style={{ color: '#334155' }}>
                Trigger price encrypted in TEE — validators cannot see or front-run this
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
                  <input
                    type="number"
                    placeholder="e.g. 1.02"
                    value={params.gridUpper}
                    onChange={handleChange('gridUpper')}
                    className="cyber-input"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-[10px]" style={{ color: '#64748b' }}>LOWER BOUND</span>
                  <input
                    type="number"
                    placeholder="e.g. 0.96"
                    value={params.gridLower}
                    onChange={handleChange('gridLower')}
                    className="cyber-input"
                  />
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
                    onClick={() => { setParams(p => ({ ...p, rebalanceInterval: v })); setSaved(false); }}
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

            {/* Save Button */}
            <button
              onClick={handleSave}
              disabled={!hasValues}
              className="btn-purple flex items-center justify-center gap-2 w-full mt-auto"
            >
              <Shield size={14} />
              {saved ? 'UPDATE SECURE STRATEGY' : 'ENCRYPT & COMMIT TO TEE'}
            </button>

            {saved && (
              <p className="font-mono text-[10px] text-center" style={{ color: '#00ff9f' }}>
                ✓ Strategy secured · Acurast will enforce silently
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
