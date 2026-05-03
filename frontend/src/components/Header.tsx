'use client';

import { WalletButton } from './WalletButton';
import { TeeHeartbeat } from './TeeHeartbeat';
import { Hexagon, Circle } from 'lucide-react';

interface HeaderProps {
  isHealthy: boolean;
  isWarning: boolean;
}

export function Header({ isHealthy, isWarning }: HeaderProps) {
  return (
    <header
      className="sticky top-0 z-50 w-full"
      style={{
        background: 'rgba(8, 10, 15, 0.85)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(0,255,159,0.08)',
        boxShadow: '0 4px 32px rgba(0,0,0,0.5)',
      }}
    >
      <div
        className="max-w-7xl mx-auto px-6 flex items-center justify-between"
        style={{ height: 64 }}
      >
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center" style={{ width: 32, height: 32 }}>
            <Hexagon
              size={32}
              style={{ color: '#00ff9f', opacity: 0.9 }}
              strokeWidth={1.5}
            />
            <span
              className="absolute font-mono font-bold"
              style={{ fontSize: 10, color: '#00ff9f', letterSpacing: '-0.02em' }}
            >
              YS
            </span>
          </div>
          <div className="flex flex-col leading-none">
            <span
              className="font-mono font-bold tracking-widest"
              style={{ fontSize: 13, color: '#e2e8f0', letterSpacing: '0.15em' }}
            >
              YIELDSENSE
            </span>
            <span
              className="font-mono"
              style={{ fontSize: 9, color: '#64748b', letterSpacing: '0.1em' }}
            >
              CONFIDENTIAL STRATEGY VAULT
            </span>
          </div>
        </div>

        {/* Center: Network Badge */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono text-xs font-semibold tracking-widest"
          style={{
            background: 'rgba(0, 82, 255, 0.08)',
            border: '1px solid rgba(0, 82, 255, 0.3)',
            color: '#4f8fff',
          }}
        >
          <Circle size={7} style={{ fill: '#4f8fff', color: '#4f8fff' }} />
          BASE Mainnet
        </div>

        {/* Right: TEE + Wallet */}
        <div className="flex items-center gap-3">
          <TeeHeartbeat isHealthy={isHealthy} isWarning={isWarning} />
          <div
            style={{
              width: 1,
              height: 24,
              background: 'rgba(255,255,255,0.08)',
            }}
          />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
