'use client';

import { useEffect, useState } from 'react';
import { Activity, Cpu, Shield } from 'lucide-react';

interface TeeHeartbeatProps {
  isHealthy: boolean;
  isWarning?: boolean;
}

const EKG_PATH = "M0,20 L20,20 L25,5 L30,35 L35,10 L40,20 L60,20";

export function TeeHeartbeat({ isHealthy, isWarning }: TeeHeartbeatProps) {
  const [tick, setTick] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
      setVisible(v => !v);
    }, isHealthy ? 900 : isWarning ? 1400 : 3000);
    return () => clearInterval(interval);
  }, [isHealthy, isWarning]);

  const color = isHealthy ? '#00ff9f' : isWarning ? '#f59e0b' : '#ff4466';
  const glowColor = isHealthy
    ? 'rgba(0,255,159,0.4)'
    : isWarning
      ? 'rgba(245,158,11,0.4)'
      : 'rgba(255,68,102,0.4)';

  const statusText = isHealthy
    ? 'ACTIVE'
    : isWarning
      ? 'DEGRADED'
      : 'HALTED';

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
      style={{
        background: 'rgba(0,0,0,0.4)',
        border: `1px solid ${color}22`,
      }}
    >
      {/* Pulsing dot */}
      <div className="relative flex items-center justify-center" style={{ width: 10, height: 10 }}>
        <div
          className="absolute rounded-full"
          style={{
            width: 10,
            height: 10,
            background: color,
            boxShadow: `0 0 8px ${glowColor}`,
            opacity: visible ? 1 : 0.3,
            transition: 'opacity 0.15s ease',
          }}
        />
        <div
          className="absolute rounded-full"
          style={{
            width: 20,
            height: 20,
            border: `1px solid ${color}`,
            opacity: visible ? 0.4 : 0,
            transform: 'scale(1)',
            animation: isHealthy ? 'pulse-ring 1s ease-out infinite' : 'none',
          }}
        />
      </div>

      {/* EKG SVG */}
      <svg
        width="48"
        height="18"
        viewBox="0 0 60 40"
        fill="none"
        style={{ overflow: 'visible' }}
      >
        <path
          d={EKG_PATH}
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          style={{
            strokeDasharray: 200,
            strokeDashoffset: isHealthy ? 0 : 120,
            transition: 'stroke-dashoffset 0.4s ease',
            opacity: 0.9,
          }}
        />
      </svg>

      <div className="flex flex-col leading-none">
        <span
          className="font-mono text-[9px] font-bold tracking-widest"
          style={{ color }}
        >
          TEE {statusText}
        </span>
        <span className="font-mono text-[9px] tracking-wide" style={{ color: '#64748b' }}>
          ACURAST VERIFIED COMPUTE
        </span>
      </div>

      <Cpu size={12} style={{ color, opacity: 0.7 }} />
    </div>
  );
}
