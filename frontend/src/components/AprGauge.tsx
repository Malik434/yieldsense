'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, Zap, Radio, Target } from 'lucide-react';

interface ConsensusData {
  geckoTerminal: number;
  dexScreener: number;
  rpc: number;
  consensus: number;
}

interface AprGaugeProps {
  previousApr: number | null;
  rewardAprEwm: number | null;
  consensusData?: ConsensusData;
}

function ArcGauge({ value, max = 80 }: { value: number; max?: number }) {
  const pct = Math.min(value / max, 1);
  const SIZE = 200;
  const STROKE = 8;
  const R = (SIZE - STROKE * 2) / 2;
  const CX = SIZE / 2;
  const CY = SIZE / 2 + 20;
  const startAngle = -210;
  const endAngle = 30;
  const totalArc = endAngle - startAngle;
  const sweepAngle = totalArc * pct;

  function polarToCartesian(angle: number) {
    const rad = (angle * Math.PI) / 180;
    return {
      x: CX + R * Math.cos(rad),
      y: CY + R * Math.sin(rad),
    };
  }

  const start = polarToCartesian(startAngle);
  const end = polarToCartesian(startAngle + sweepAngle);
  const bgEnd = polarToCartesian(endAngle);
  const largeArc = sweepAngle > 180 ? 1 : 0;
  const bgLargeArc = totalArc > 180 ? 1 : 0;

  const bgPath = `M ${start.x} ${start.y} A ${R} ${R} 0 ${bgLargeArc} 1 ${bgEnd.x} ${bgEnd.y}`;
  const activePath = sweepAngle > 0
    ? `M ${start.x} ${start.y} A ${R} ${R} 0 ${largeArc} 1 ${end.x} ${end.y}`
    : null;

  return (
    <svg width={SIZE} height={SIZE - 20} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#C2E812" />
          <stop offset="100%" stopColor="#00FFA3" />
        </linearGradient>
      </defs>
      <path
        d={bgPath}
        fill="none"
        stroke="rgba(255,255,255,0.03)"
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      {activePath && (
        <path
          d={activePath}
          fill="none"
          stroke="url(#gaugeGrad)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          style={{ transition: 'all 1.5s cubic-bezier(0.2, 0, 0, 1)' }}
        />
      )}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const a = startAngle + totalArc * t;
        const inner = polarToCartesian(a);
        const outer = { x: CX + (R + 6) * Math.cos((a * Math.PI) / 180), y: CY + (R + 6) * Math.sin((a * Math.PI) / 180) };
        return (
          <line
            key={t}
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}

export function AprGauge({ previousApr, rewardAprEwm, consensusData }: AprGaugeProps) {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setAnimate(true), 200);
    return () => clearTimeout(t);
  }, []);

  const aprBps = previousApr ?? 0;
  const aprPct = aprBps / 100;

  let ewmPct = 0;
  if (rewardAprEwm != null && rewardAprEwm !== 0) {
    ewmPct = rewardAprEwm * 100;
  } else {
    ewmPct = aprPct;
  }
  const ewmIsLive = rewardAprEwm != null && rewardAprEwm !== 0;

  const sources = consensusData
    ? [
      { label: 'GECKO', value: consensusData.geckoTerminal / 100, color: '#C2E812' },
      { label: 'DEXSCREENER', value: consensusData.dexScreener / 100, color: '#0ea5e9' },
      { label: 'RPC', value: consensusData.rpc / 100, color: '#00FFA3' },
    ]
    : [];

  return (
    <div className="ys-card p-10 flex flex-col items-center gap-10 relative overflow-hidden group bg-[#0B0F0D]">
      <div className="absolute top-0 right-0 p-12 bg-[#C2E812]/[0.02] rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />

      <div className="w-full flex items-center justify-between relative z-10">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-white/5 border border-white/10">
            <TrendingUp size={18} className="text-[#C2E812]" />
          </div>
          <div>
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Consensus Audit</p>
            <h3 className="text-xl font-heading font-bold text-[#F5F7FA]">Yield Velocity</h3>
          </div>
        </div>
        <div className="ys-badge-accent py-1.5 px-4">
          <Zap size={12} />
          LIVE
        </div>
      </div>

      <div className="relative flex flex-col items-center py-4">
        <ArcGauge value={animate ? aprPct : 0} max={Math.max(50, Math.ceil(aprPct / 50) * 50)} />
        <div className="absolute flex flex-col items-center bottom-4 translate-y-2">
          <div className="flex items-baseline gap-1">
            <h2 className="text-6xl font-heading font-bold tracking-tighter text-[#F5F7FA] leading-none">
              {aprPct.toFixed(2)}
            </h2>
            <span className="text-xl font-heading font-bold text-[#484F58]">%</span>
          </div>
          <span className="text-[10px] font-mono font-bold text-[#C2E812] mt-4 tracking-[0.4em] uppercase">
            Current APR
          </span>
        </div>
      </div>

      <div className="w-full rounded-2xl p-6 bg-white/[0.02] border border-white/[0.04] flex items-center justify-between relative z-10">
        <span className="text-[10px] font-mono font-bold text-[#484F58] tracking-widest uppercase">
          {ewmIsLive ? 'SMOOTHED (EWMA)' : 'CONSENSUS MEAN'}
        </span>
        <span className="text-lg font-heading font-bold text-[#C2E812]">
          {ewmPct.toFixed(2)}%
        </span>
      </div>

      {sources.length > 0 && (
        <div className="w-full flex flex-col gap-6 pt-4 relative z-10">
          <div className="flex items-center gap-3 mb-2">
            <Radio size={14} className="text-[#484F58]" />
            <span className="text-[10px] font-mono font-bold tracking-[0.3em] text-[#484F58] uppercase">
              Consensus Node Audit
            </span>
          </div>
          <div className="space-y-4">
            {sources.map((s) => (
              <div key={s.label} className="flex items-center justify-between">
                <span className="text-[10px] font-mono font-bold tracking-widest text-[#8B949E] uppercase">
                  {s.label}
                </span>
                <div className="flex items-center gap-4">
                  <div className="w-24 h-1.5 rounded-full bg-white/[0.03] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-1000 ease-out"
                      style={{
                        width: `${Math.min(s.value, 100)}%`,
                        backgroundColor: s.color
                      }}
                    />
                  </div>
                  <span className="text-[11px] font-mono font-bold text-[#F5F7FA] min-w-[50px] text-right">
                    {s.value.toFixed(2)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
