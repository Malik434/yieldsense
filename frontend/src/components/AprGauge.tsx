'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, Zap, Radio } from 'lucide-react';

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
  const STROKE = 12;
  const R = (SIZE - STROKE * 2) / 2;
  const CX = SIZE / 2;
  const CY = SIZE / 2 + 20;
  // Arc from -210deg to 30deg (240deg span)
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
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="50%" stopColor="#00d4ff" />
          <stop offset="100%" stopColor="#00ff9f" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Background arc */}
      <path
        d={bgPath}
        fill="none"
        stroke="rgba(255,255,255,0.05)"
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      {/* Active arc */}
      {activePath && (
        <path
          d={activePath}
          fill="none"
          stroke="url(#gaugeGrad)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          filter="url(#glow)"
          style={{ transition: 'all 1s ease-out' }}
        />
      )}
      {/* Tick marks */}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const a = startAngle + totalArc * t;
        const inner = polarToCartesian(a);
        const outer = { x: CX + (R + STROKE) * Math.cos((a * Math.PI) / 180), y: CY + (R + STROKE) * Math.sin((a * Math.PI) / 180) };
        return (
          <line
            key={t}
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
            stroke="rgba(255,255,255,0.15)"
            strokeWidth="1.5"
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

  // rewardAprEwm is a decimal fraction (0.19 = 19%) from the yield engine EWMA.
  // When it hasn't been seeded by the worker yet, fall back to the consensus APR
  // (which is already in BPS, so divide by 100 to get percent).
  const ewmPct =
    rewardAprEwm != null
      ? rewardAprEwm * 100
      : consensusData != null
        ? consensusData.consensus / 100
        : 0;
  const ewmIsLive = rewardAprEwm != null;

  const sources = consensusData
    ? [
        { label: 'GECKO', value: consensusData.geckoTerminal / 100, color: '#f59e0b' },
        { label: 'DEXSCREENER', value: consensusData.dexScreener / 100, color: '#00d4ff' },
        { label: 'RPC', value: consensusData.rpc / 100, color: '#a78bfa' },
      ]
    : [];

  return (
    <div className="cyber-card p-6 flex flex-col items-center gap-4">
      <div className="w-full flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp size={15} style={{ color: '#00ff9f' }} />
          <span className="neon-label">CONSENSUS APR GAUGE</span>
        </div>
        <span className="status-badge verified">
          <Zap size={9} />
          VERIFIED YIELD
        </span>
      </div>

      {/* Gauge — max scales to the next clean ceiling above the actual APR */}
      <div className="relative flex flex-col items-center">
        <ArcGauge value={animate ? aprPct : 0} max={Math.max(50, Math.ceil(aprPct / 50) * 50)} />
        <div
          className="absolute flex flex-col items-center"
          style={{ bottom: 0 }}
        >
          <span
            className="font-mono font-bold"
            style={{ fontSize: 36, color: '#00ff9f', lineHeight: 1, textShadow: '0 0 20px rgba(0,255,159,0.5)' }}
          >
            {aprPct.toFixed(2)}
            <span style={{ fontSize: 18, color: '#64748b' }}>%</span>
          </span>
          <span className="font-mono text-xs mt-1" style={{ color: '#64748b', letterSpacing: '0.1em' }}>
            CONSENSUS APR
          </span>
        </div>
      </div>

      {/* EWM smoothed */}
      <div
        className="w-full rounded-lg p-3 flex items-center justify-between"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)' }}
      >
        <span className="font-mono text-xs" style={{ color: '#64748b' }}>
          {ewmIsLive ? 'SMOOTHED (EWMA)' : 'SMOOTHED (CONSENSUS)'}
        </span>
        <span className="font-mono font-semibold text-sm" style={{ color: '#a78bfa' }}>
          {ewmPct.toFixed(2)}%
        </span>
      </div>

      {/* Source breakdown */}
      {sources.length > 0 && (
        <div className="w-full flex flex-col gap-2">
          <div className="flex items-center gap-1.5 mb-1">
            <Radio size={10} style={{ color: '#64748b' }} />
            <span className="font-mono text-[10px] tracking-widest" style={{ color: '#64748b' }}>
              DATA SOURCES
            </span>
          </div>
          {sources.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <span className="font-mono text-[10px] tracking-widest" style={{ color: '#475569' }}>
                {s.label}
              </span>
              <div className="flex items-center gap-2">
                <div
                  className="rounded-full"
                  style={{ width: `${Math.min(s.value * 2, 80)}px`, height: 3, background: s.color, opacity: 0.6 }}
                />
                <span className="font-mono text-xs font-semibold" style={{ color: s.color, minWidth: 50, textAlign: 'right' }}>
                  {s.value.toFixed(2)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
