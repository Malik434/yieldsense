'use client';

import { useEffect, useState, useRef } from 'react';
import { TrendingUp, ArrowUpRight, DollarSign, Zap } from 'lucide-react';

interface PortfolioTickerProps {
  balance: number;
  unrealizedYield: number;
  totalRealized: number;
  apr: number;
}

export function PortfolioTicker({ balance, unrealizedYield, totalRealized, apr }: PortfolioTickerProps) {
  const [displayYield, setDisplayYield] = useState(unrealizedYield);
  const lastUpdateRef = useRef(Date.now());
  
  // Per-second yield rate = (balance * apr) / (365 * 24 * 3600)
  // apr is in decimal (e.g. 0.1 for 10%)
  const yieldPerMs = (balance * (apr)) / (365 * 24 * 3600 * 1000);

  useEffect(() => {
    setDisplayYield(unrealizedYield);
  }, [unrealizedYield]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const delta = now - lastUpdateRef.current;
      lastUpdateRef.current = now;
      
      if (apr > 0 && balance > 0) {
        setDisplayYield(prev => prev + yieldPerMs * delta);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [balance, apr, yieldPerMs]);

  const totalPortfolio = balance + displayYield;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
      {/* Total Portfolio Value */}
      <div className="cyber-card p-6 relative overflow-hidden group">
        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <TrendingUp size={64} />
        </div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <TrendingUp size={14} className="text-blue-400" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-widest text-slate-400 uppercase">Total Portfolio</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tracking-tighter text-white">
              ${totalPortfolio.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
              <ArrowUpRight size={10} className="text-emerald-400" />
              <span className="text-[10px] font-mono font-bold text-emerald-400">LIVE</span>
            </div>
            <span className="text-[10px] font-mono text-slate-500">Updating via TEE Oracle</span>
          </div>
        </div>
      </div>

      {/* Unrealized Yield (The Ticker) */}
      <div className="cyber-card p-6 relative overflow-hidden group border-emerald-500/20">
        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Zap size={64} className="text-emerald-400" />
        </div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <Zap size={14} className="text-emerald-400" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-widest text-emerald-400 uppercase">Unrealized Yield</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tracking-tighter text-emerald-400">
              ${displayYield.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 })}
            </span>
          </div>
          <div className="mt-2 text-[10px] font-mono text-slate-500">
            Accruing at <span className="text-emerald-400">${(yieldPerMs * 1000 * 60).toFixed(6)}/min</span>
          </div>
        </div>
      </div>

      {/* Total Realized Profit */}
      <div className="cyber-card p-6 relative overflow-hidden group border-purple-500/20">
        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <DollarSign size={64} className="text-purple-400" />
        </div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <DollarSign size={14} className="text-purple-400" />
            </div>
            <span className="text-[10px] font-mono font-bold tracking-widest text-purple-400 uppercase">Realized Profit</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tracking-tighter text-purple-400">
              ${totalRealized.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="mt-2 text-[10px] font-mono text-slate-500">
            Yield secured in vault
          </div>
        </div>
      </div>
    </div>
  );
}
