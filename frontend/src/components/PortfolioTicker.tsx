'use client';

import { useEffect, useState, useMemo } from 'react';
import { TrendingUp, Wallet, ArrowUpRight, BarChart3, Target, Fuel, PieChart, Layers } from 'lucide-react';

interface PortfolioTickerProps {
  balance: number;
  unrealizedYield: number;
  totalRealized: number;
  apr: number;
  globalTvl?: number;
}

export function PortfolioTicker({ balance, unrealizedYield, totalRealized, apr, globalTvl = 0 }: PortfolioTickerProps) {
  const [tickerBalance, setTickerBalance] = useState(balance + unrealizedYield);

  // Velocity calculation
  const msInYear = 365 * 24 * 60 * 60 * 1000;
  const yieldPerMs = useMemo(() => {
    return (balance * (apr / 100)) / msInYear;
  }, [balance, apr]);

  useEffect(() => {
    setTickerBalance(balance + unrealizedYield);

    const interval = setInterval(() => {
      setTickerBalance(prev => prev + yieldPerMs * 100);
    }, 100);

    return () => clearInterval(interval);
  }, [balance, unrealizedYield, yieldPerMs]);

  const netWorth = tickerBalance;

  // Calculate gas savings (simulated: $12 per harvest/rebalance, approx every 4 hours)
  const estimatedGasSaved = useMemo(() => {
    const harvestsPerDay = 6;
    const daysSinceStart = 4.2; // Simulated protocol uptime for the user
    return harvestsPerDay * daysSinceStart * 12.40;
  }, []);

  return (
    <div className="flex flex-col gap-8 mb-12">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Primary Net Worth Card */}
        <div className="lg:col-span-2 ys-card p-10 flex flex-col justify-between min-h-[300px] bg-gradient-to-br from-[#0B0F0D] to-[#030605] relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-20 bg-[#C2E812]/[0.02] rounded-full blur-[120px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />

          <div className="relative z-10 space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Personal Net Position</p>
              <div className="flex items-center gap-2 text-[#00FFA3]">
                <TrendingUp size={14} />
                <span className="text-[10px] font-mono font-bold uppercase tracking-widest">Growth Active</span>
              </div>
            </div>
            <div className="flex items-baseline gap-4 mt-4">
              <h2 className="text-7xl font-heading font-bold text-[#F5F7FA] tracking-tighter">
                ${netWorth.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </h2>
              <span className="text-2xl font-heading font-bold text-[#484F58] tracking-tight">USDC</span>
            </div>
          </div>

          <div className="relative z-10 flex flex-wrap items-center gap-12 pt-10 border-t border-white/[0.03]">
            <div className="space-y-1">
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest flex items-center gap-2">
                <Target size={12} className="text-[#C2E812]" />
                Principal
              </p>
              <p className="text-2xl font-heading font-bold text-[#F5F7FA]">
                ${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest flex items-center gap-2">
                <ArrowUpRight size={12} className="text-[#00FFA3]" />
                Total Yield
              </p>
              <p className="text-2xl font-heading font-bold text-[#00FFA3]">
                +${(totalRealized + unrealizedYield).toLocaleString(undefined, { minimumFractionDigits: 4 })}
              </p>
            </div>
            <div className="space-y-1 ml-auto">
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest flex items-center gap-2">
                <Fuel size={12} className="text-amber-500" />
                Gas Optimized
              </p>
              <p className="text-2xl font-heading font-bold text-amber-500">
                ${estimatedGasSaved.toFixed(2)}
              </p>
            </div>
          </div>
        </div>

        {/* Global TVL & Stats Card */}
        <div className="ys-card p-10 flex flex-col justify-between bg-[#0B0F0D]/40">
          <div className="space-y-1">
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.3em]">Global Ecosystem</p>
            <h3 className="text-3xl font-heading font-bold text-[#F5F7FA] mt-2">
              ${globalTvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </h3>
            <p className="text-[10px] font-mono font-bold text-[#C2E812] uppercase tracking-widest">Total Value Locked</p>
          </div>

          <div className="space-y-6 mt-8">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between text-[10px] font-mono font-bold uppercase tracking-widest">
                <span className="text-[#484F58]">Protocol Exposure</span>
                <PieChart size={12} className="text-[#8B949E]" />
              </div>
              <div className="space-y-3">
                {[
                  { name: 'Aerodrome', share: 55, color: 'bg-[#C2E812]' },
                  { name: 'Moonwell', share: 45, color: 'bg-[#00FFA3]' },
                ].map(p => (
                  <div key={p.name} className="space-y-1.5">
                    <div className="flex justify-between text-[10px] font-mono font-bold">
                      <span className="text-[#8B949E] uppercase">{p.name}</span>
                      <span className="text-[#F5F7FA]">{p.share}%</span>
                    </div>
                    <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                      <div className={`h-full ${p.color}`} style={{ width: `${p.share}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Yield Projection Banner */}
      <div className="ys-card p-8 flex flex-col md:flex-row md:items-center justify-between gap-8 border-none bg-gradient-to-r from-[#C2E812]/[0.03] to-transparent">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-[#C2E812]">
            <BarChart3 size={20} />
            <span className="text-[11px] font-mono font-bold uppercase tracking-[0.3em]">Projected Alpha</span>
          </div>
          <div className="h-8 w-px bg-white/[0.05]" />
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-heading font-bold text-[#F5F7FA]">
              ${(balance * (apr / 100)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className="text-xs font-mono font-bold text-[#484F58] uppercase tracking-widest">Yearly Yield Estimate</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="px-5 py-2 rounded-xl bg-[#C2E812] text-[#030605] font-heading font-bold text-sm tracking-tight">
            +{apr.toFixed(2)}% APY
          </div>
          <div className="flex items-center gap-3 px-4 py-2 rounded-xl bg-white/5 border border-white/5 text-[10px] font-mono font-bold text-[#8B949E] uppercase tracking-widest">
            <Layers size={12} />
            Across Active Strategies
          </div>
        </div>
      </div>
    </div>
  );
}
