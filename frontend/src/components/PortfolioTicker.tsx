'use client';

import { useEffect, useState, useMemo } from 'react';
import { BarChart3, PieChart, Layers } from 'lucide-react';

const MS_IN_YEAR = 365 * 24 * 60 * 60 * 1000;

interface PortfolioTickerProps {
  balance: number;
  unrealizedYield: number;
  totalRealized: number;
  /** Percentage APR, e.g. 25.54 means 25.54%. */
  apr: number;
  globalTvl?: number;
}

export function PortfolioTicker({ balance, unrealizedYield, totalRealized, apr, globalTvl = 0 }: PortfolioTickerProps) {
  // Net Worth already includes realized yield (compounded in share price).
  // We only add unrealizedYield (pending in strategy) to get the true total value.
  const currentPositionValue = useMemo(() => {
    const value = balance + unrealizedYield;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }, [balance, unrealizedYield]);
  const projectedAnnualYield = useMemo(() => {
    const value = currentPositionValue * (apr / 100);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }, [currentPositionValue, apr]);
  const hasActivePosition = currentPositionValue > 0;
  const [tickerBalance, setTickerBalance] = useState(currentPositionValue);

  // Velocity calculation
  const yieldPerMs = useMemo(() => {
    return projectedAnnualYield / MS_IN_YEAR;
  }, [projectedAnnualYield]);

  useEffect(() => {
    setTickerBalance(currentPositionValue);

    const interval = setInterval(() => {
      setTickerBalance(prev => prev + yieldPerMs * 100);
    }, 100);

    return () => clearInterval(interval);
  }, [currentPositionValue, yieldPerMs]);

  const netWorth = tickerBalance;

  // Calculate gas savings ($12.40 avg L2 gas saved per autonomous harvest)
  const estimatedGasSaved = useMemo(() => {
    // Principal-based activity estimate
    const activityFactor = Math.max(1, balance / 100); 
    return activityFactor * 12.40 * 2.5;
  }, [balance]);

  return (
    <div className="mb-10 flex flex-col gap-5 sm:mb-12 sm:gap-8">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3 lg:gap-8">
        {/* Primary Net Worth Card */}
        <div className="ys-card relative flex min-h-[260px] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#0B0F0D] to-[#030605] p-5 group sm:p-8 lg:col-span-2 lg:min-h-[300px] lg:p-10">
          <div className="absolute top-0 right-0 p-20 bg-[#C2E812]/[0.02] rounded-full blur-[120px] -translate-y-1/2 translate-x-1/2 pointer-events-none" />

          <div className="relative z-10 space-y-1">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] sm:text-[11px] sm:tracking-[0.3em]">Personal Net Position</p>
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
                <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E]">
                  {hasActivePosition ? 'Position Active' : 'No Position'}
                </span>
              </div>
            </div>
            <div className="mt-4 flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
              <h2 className="break-words text-[clamp(2.35rem,14vw,4.5rem)] font-heading font-bold leading-none tracking-tight text-[#F5F7FA]">
                ${netWorth.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </h2>
              <span className="text-lg font-heading font-bold tracking-tight text-[#484F58] sm:text-2xl">USDC</span>
            </div>
          </div>

          <div className="relative z-10 grid grid-cols-1 gap-3 border-t border-white/[0.03] pt-8 sm:grid-cols-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Principal</p>
              <p className="mt-2 text-xl font-heading font-bold text-[#F5F7FA]">
                ${(balance - totalRealized).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Total Yield</p>
              <p className="mt-2 text-xl font-heading font-bold text-[#F5F7FA]">
                +${(totalRealized + unrealizedYield).toLocaleString(undefined, { minimumFractionDigits: 4 })}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
              <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-widest">Estimated Gas Offset</p>
              <p className="mt-2 text-xl font-heading font-bold text-[#F5F7FA]">
                ${estimatedGasSaved.toFixed(2)}
              </p>
            </div>
          </div>
        </div>

        {/* Global TVL & Stats Card */}
        <div className="ys-card flex flex-col justify-between bg-[#0B0F0D]/40 p-5 sm:p-8 lg:p-10">
          <div className="space-y-1">
            <p className="text-[10px] font-mono font-bold text-[#484F58] uppercase tracking-[0.2em] sm:tracking-[0.3em]">Global Ecosystem</p>
            <h3 className="mt-2 break-words text-2xl font-heading font-bold text-[#F5F7FA] sm:text-3xl">
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
                  { name: 'Aerodrome USDC/AERO', share: 100, color: 'bg-[#C2E812]' },
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
      <div className="ys-card flex flex-col gap-5 border-none bg-gradient-to-r from-[#C2E812]/[0.03] to-transparent p-5 sm:p-8 md:flex-row md:items-center md:justify-between md:gap-8">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <div className="flex shrink-0 items-center gap-2 text-[#C2E812]">
            <BarChart3 size={20} />
            <span className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] sm:text-[11px] sm:tracking-[0.3em]">Projected Alpha</span>
          </div>
          <div className="hidden h-8 w-px bg-white/[0.05] sm:block" />
          <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
            <span className="break-words text-2xl font-heading font-bold text-[#F5F7FA] sm:text-3xl">
              ${projectedAnnualYield.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className="text-xs font-mono font-bold text-[#484F58] uppercase tracking-widest">
              {hasActivePosition ? 'Projected Annual Yield' : 'No Active Position'}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="rounded-xl bg-[#C2E812] px-4 py-2 text-center text-sm font-heading font-bold tracking-tight text-[#030605] sm:px-5">
            +{apr.toFixed(2)}% Strategy APR
          </div>
          <div className="flex items-center justify-center gap-3 rounded-xl border border-white/5 bg-white/5 px-4 py-2 text-center text-[10px] font-mono font-bold uppercase tracking-widest text-[#8B949E]">
            <Layers size={12} />
            Aerodrome MVP Strategy
          </div>
        </div>
      </div>
    </div>
  );
}
